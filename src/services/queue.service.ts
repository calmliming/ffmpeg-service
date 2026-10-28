import fs from 'fs';
import path from 'path';
import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import type IORedis from 'ioredis';
import { config } from '../config';
import { createRedis } from '../utils/redis';
import { cancelChannel, publishCancel, subscribeCancels } from '../core/cancel';
import { createOperationContext } from '../core/context';
import { normalizeRawParams } from '../core/params';
import { HttpError } from '../middleware/error';
import {
  countUrlInputs,
  isInside,
  materializeInputs,
  type JobInput,
  type JobInputs,
  type MaterializeSlot,
} from '../core/inputs';
import { PIPELINE_OP, type PipelineStepPayload } from '../core/pipeline';
import { formatIssues } from '../middleware/validate';
import type { AnyOperation, OperationResult, ProgressExtra } from '../operations/types';
import type { PipelineStep, PipelineStepStatus, Task, TaskOutput, TaskPhase } from '../types';
import {
  defaultStorageSettings,
  deleteStoredOutputs,
  relativeOutputPath,
  storageDriver,
  storeOutputs as defaultStoreOutputs,
  type StoredOutput,
} from './storage.service';
import {
  isTerminal,
  taskService as defaultTaskService,
  type TaskService,
  type TaskUpdates,
} from './task.service';

export const QUEUE_NAME = 'ffmpeg';

/** 入队的 job：jobId 等于 taskId，job 名等于操作名 */
export interface JobPayload {
  taskId: string;
  op: string;
  inputs: JobInputs;
  /** op.params 解析后的输出（JSON 可序列化） */
  params: Record<string, unknown>;
  callbackUrl?: string;
}

/** POST /api/pipeline 的 job：job 名和 op 都是 pipeline，各步骤的参数在提交时已校验 */
export interface PipelineJobPayload {
  taskId: string;
  op: typeof PIPELINE_OP;
  /** 第一步的 file 输入（上传或链接） */
  inputs: JobInputs;
  steps: PipelineStepPayload[];
  callbackUrl?: string;
}

/** 升级前（fluent-ffmpeg 版本）入队的 job，服务升级时可能还留在 Redis 里 */
export interface LegacyJobPayload {
  taskId: string;
  type: string;
  inputPath?: string;
  inputPaths?: string[];
  options?: Record<string, unknown>;
  format?: string;
}

export type SubmittedJobData = JobPayload | PipelineJobPayload;
export type QueuedJobData = SubmittedJobData | LegacyJobPayload;
export type JobQueue = Queue<SubmittedJobData>;
export type TaskWorker = Worker<QueuedJobData>;
export type StoreOutputs = typeof defaultStoreOutputs;
export type { JobInput, JobInputs };

/** 产物存储（上传 S3 等）占总进度的最后 3% */
const STORE_START = 0.97;
/** Worker 查一次任务状态的间隔：取消广播丢失时，最迟这么久之后停下来 */
const CANCEL_POLL_MS = 5000;
const DEFAULT_CANCEL_REASON = '任务已取消';

/**
 * 单个操作的产物先写在任务 workDir 里的这个目录，全部校验通过后才移进输出目录。进程中途被杀时，
 * 写了一半的产物只会留在 uploads/<taskId> 里（重新执行时整个删掉，48 小时清理也会删），不会出现在 /api/files 下。
 * 以点开头：ctx.tempPath 的名字不能以点开头，不会和操作的临时文件撞名
 */
export const STAGING_DIR = '.output';
/** 跨文件系统移动产物时（Docker 里 uploads 在容器层、output 是卷）先复制到输出目录里的这个目录再改名。以点开头，不会被下载 */
const PARTIAL_DIR = '.partial';
/** taskId 会拼进要递归删除的目录路径，伪造的 job（如 taskId 为 ..）不能借此删到别处 */
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const workDirOf = (taskId: string) => path.join(config.uploadDir, taskId);
const partialDirOf = (taskId: string) => path.join(config.outputDir, PARTIAL_DIR, taskId);

/**
 * BullMQ 的连接从未就绪时（进程启动时 Redis 就连不上），命令根本不会发出，也就不受 commandTimeout 限制，
 * 而是一直等到 Redis 恢复（BullMQ RedisConnection.waitUntilReady 只等 ready 事件）。HTTP 请求里用到的队列操作
 * 都套上这个超时，超时按服务暂时不可用（503）回复
 */
export const QUEUE_COMMAND_TIMEOUT_MS = 5000;

export function withQueueTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = QUEUE_COMMAND_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HttpError(503, '任务服务暂时不可用，请稍后重试')),
      timeoutMs,
    );
  });
  // 超时之后原来的命令可能在 Redis 恢复时才失败，没人等它的结果，不能变成未处理的拒绝
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Queue / Worker 没挂 error 监听时 BullMQ 会把每次重连失败都直接打到 stderr，这里统一节流
function throttledLogger(label: string) {
  let last = 0;
  return (err: Error) => {
    const now = Date.now();
    if (now - last < 30_000) return;
    last = now;
    console.error(`[${label}] ${err.message}`);
  };
}

export interface QueueConnectionOptions {
  /** 默认按 config.redisUrl 新建连接 */
  connection?: IORedis;
  /** BullMQ key 前缀，默认 bull */
  prefix?: string;
}

export function createJobQueue(opts: QueueConnectionOptions = {}): JobQueue {
  // 入队用快速失败的连接：Redis 不可用时几秒内报错，而不是让提交任务的 HTTP 请求无限等待
  const connection =
    opts.connection ??
    createRedis('queue', { maxRetriesPerRequest: 2, connectTimeout: 3000, commandTimeout: 5000 });
  const queue = new Queue<SubmittedJobData>(QUEUE_NAME, {
    connection,
    // BullMQ 用对象展开合并默认值，显式传 prefix: undefined 会把默认的 bull 覆盖掉
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
    // 不设置的话已完成和失败的 job 会永久留在 Redis 里，越积越多
    defaultJobOptions: {
      removeOnComplete: { age: config.taskTtlSeconds, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });
  queue.on('error', throttledLogger('BullMQ Queue Error'));
  return queue;
}

let defaultQueue: JobQueue | undefined;

/** 进程内共用的队列，第一次调用时才连接 Redis */
export function getJobQueue(): JobQueue {
  defaultQueue ??= createJobQueue();
  return defaultQueue;
}

type GetOperation = (name: string) => AnyOperation | undefined;
type Mapped = { op: AnyOperation; payload: JobPayload } | { error: string };

function legacyError(type: string, detail: string): { error: string } {
  return { error: `升级前提交的 ${type || '未知类型'} 任务${detail}，请重新提交` };
}

/**
 * 把升级前的 job 映射成新格式：inputPath / inputPaths 给第一个合适的输入槽，
 * options 里与输入槽同名的字段（watermark 的 image 是上传路径，compose 的 videos / music 是链接）作为该槽的输入，
 * 其余 options 和 format 按新接口的参数重新校验
 */
export function mapLegacyJob(data: LegacyJobPayload, getOperation: GetOperation): Mapped {
  const type = typeof data.type === 'string' ? data.type : '';
  const op = type ? getOperation(type) : undefined;
  if (!op || op.sync) return legacyError(type, '在新版服务中没有对应的操作');

  const inputs: JobInputs = {};
  const raw: Record<string, unknown> = { ...(data.options ?? {}) };
  if (data.format !== undefined) raw.format = data.format;
  for (const slot of op.inputs) {
    if (!(slot.name in raw)) continue;
    const value = raw[slot.name];
    delete raw[slot.name];
    const list = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    if (list.length) {
      inputs[slot.name] = list.map((v) => (/^https?:\/\//i.test(v) ? { url: v } : { path: v }));
    }
  }

  const paths = data.inputPaths ?? (data.inputPath ? [data.inputPath] : []);
  if (paths.length) {
    const free = op.inputs.filter((slot) => !inputs[slot.name]);
    const slot =
      free.find((s) => s.required && (paths.length === 1 || s.multiple)) ??
      free.find((s) => paths.length === 1 || s.multiple);
    if (!slot) return legacyError(type, '的输入文件无法对应到新版接口');
    inputs[slot.name] = paths.map((p) => ({ path: p }));
  }

  for (const slot of op.inputs) {
    if (slot.required && !inputs[slot.name]?.length) {
      return legacyError(type, `缺少 ${slot.name} 输入`);
    }
  }
  const parsed = op.params.safeParse(normalizeRawParams(raw));
  if (!parsed.success) {
    return legacyError(type, `的参数与新版接口不兼容（${formatIssues(parsed.error.issues)}）`);
  }
  const provided = Object.fromEntries(op.inputs.map((s) => [s.name, inputs[s.name]?.length ?? 0]));
  const problem = op.check?.(parsed.data, provided);
  if (problem) return legacyError(type, `的参数与新版接口不兼容（${problem}）`);
  return {
    op,
    payload: {
      taskId: data.taskId,
      op: op.name,
      inputs,
      params: parsed.data as Record<string, unknown>,
    },
  };
}

/** 执行计划里的一步。单个操作的 job 是只有一步的计划 */
export interface PlannedStep {
  op: AnyOperation;
  params: Record<string, unknown>;
  /** 本步的输入；pipeline 第 2 步起的 file 在执行时由上一步的主产物填上 */
  inputs: JobInputs;
}

export type JobPlan = { steps: PlannedStep[]; pipeline: boolean } | { error: string };

export function isPipelineJob(data: QueuedJobData): data is PipelineJobPayload {
  return 'op' in data && data.op === PIPELINE_OP;
}

export function resolveJob(data: QueuedJobData, getOperation: GetOperation): JobPlan {
  if (isPipelineJob(data)) {
    if (!Array.isArray(data.steps) || data.steps.length === 0 || !data.inputs?.file?.length) {
      return { error: 'pipeline 任务数据不完整，请重新提交' };
    }
    const steps: PlannedStep[] = [];
    for (const [index, step] of data.steps.entries()) {
      const op = getOperation(step.op);
      if (!op || op.sync) return { error: `服务端已不再支持操作 ${step.op}，请重新提交` };
      const inputs: JobInputs = { ...(step.inputs ?? {}) };
      if (index === 0) inputs.file = data.inputs.file;
      steps.push({ op, params: step.params ?? {}, inputs });
    }
    return { steps, pipeline: true };
  }
  if ('op' in data && typeof data.op === 'string') {
    const op = getOperation(data.op);
    if (!op || op.sync) return { error: `服务端已不再支持操作 ${data.op}，请重新提交` };
    return {
      steps: [{ op, params: data.params ?? {}, inputs: data.inputs ?? {} }],
      pipeline: false,
    };
  }
  const mapped = mapLegacyJob(data as LegacyJobPayload, getOperation);
  if ('error' in mapped) return mapped;
  return {
    steps: [{ op: mapped.op, params: mapped.payload.params, inputs: mapped.payload.inputs }],
    pipeline: false,
  };
}

function inputPaths(inputs: unknown): string[] {
  const paths: string[] = [];
  if (!inputs || typeof inputs !== 'object') return paths;
  for (const items of Object.values(inputs as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue;
    for (const item of items as unknown[]) {
      const p = (item as { path?: unknown } | null)?.path;
      if (typeof p === 'string') paths.push(p);
    }
  }
  return paths;
}

/** job 引用的上传文件，任务结束（或排队时被取消）后删除。只认 uploads 目录里的路径，伪造的 job 删不到别处 */
export function jobUploadPaths(data: QueuedJobData): string[] {
  const paths: string[] = [];
  if ('op' in data) {
    paths.push(...inputPaths(data.inputs));
    if (isPipelineJob(data) && Array.isArray(data.steps)) {
      for (const step of data.steps) paths.push(...inputPaths(step?.inputs));
    }
  } else {
    const legacy = data as LegacyJobPayload;
    if (legacy.inputPath) paths.push(legacy.inputPath);
    if (Array.isArray(legacy.inputPaths)) paths.push(...legacy.inputPaths);
    const image = legacy.options?.image;
    if (typeof image === 'string') paths.push(image);
  }
  return paths.filter((p) => typeof p === 'string' && isInside(config.uploadDir, p));
}

export async function removePaths(paths: readonly string[]): Promise<void> {
  await Promise.all(
    paths.map((p) => fs.promises.rm(p, { recursive: true, force: true }).catch(() => {})),
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** cancelJob(jobId, reason) 的 reason 会成为 signal.reason，作为取消原因写进任务 */
function cancelMessage(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.name !== 'AbortError' && reason.message) {
    return reason.message;
  }
  return DEFAULT_CANCEL_REASON;
}

/**
 * 进度写入：只在整数百分比、阶段或片段序号变化时写 Redis，同一时间最多一个写入在途，
 * 期间的更新合并成一次。进度只增不减，存储完成前最多 99%
 */
class ProgressReporter {
  private percent = 0;
  private phase?: TaskPhase;
  private currentVideoIndex?: number;
  private totalVideos?: number;
  private pending?: TaskUpdates;
  private writing?: Promise<void>;

  constructor(
    private readonly tasks: TaskService,
    private readonly taskId: string,
    private readonly log: (message: string) => void,
  ) {}

  /** percent 是任务记录里已有的进度：进程崩溃后被重新执行的 job 从上次的进度往上走，不倒退回 0 */
  start(phase: TaskPhase, percent = 0): void {
    this.phase = phase;
    this.percent = Math.min(99, Math.max(0, Math.floor(percent)));
  }

  report(fraction: number, extra: ProgressExtra = {}): void {
    const updates: TaskUpdates = {};
    const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    const percent = Math.min(99, Math.floor(clamped * 100));
    if (percent > this.percent) {
      this.percent = percent;
      updates.progress = percent;
    }
    if (extra.phase && extra.phase !== this.phase) {
      this.phase = extra.phase;
      updates.phase = extra.phase;
      this.log(`阶段: ${extra.phase}（${this.percent}%）`);
    }
    if (
      extra.currentVideoIndex !== undefined &&
      extra.currentVideoIndex !== this.currentVideoIndex
    ) {
      this.currentVideoIndex = extra.currentVideoIndex;
      updates.currentVideoIndex = extra.currentVideoIndex;
    }
    if (extra.totalVideos !== undefined && extra.totalVideos !== this.totalVideos) {
      this.totalVideos = extra.totalVideos;
      updates.totalVideos = extra.totalVideos;
    }
    this.write(updates);
  }

  /** 其他非终态字段（pipeline 的步骤状态），和进度合并写入，保证先后顺序 */
  write(updates: TaskUpdates): void {
    if (Object.keys(updates).length === 0) return;
    this.pending = { ...this.pending, ...updates };
    this.writing ??= this.drain();
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const updates = this.pending;
      this.pending = undefined;
      try {
        await this.tasks.update(this.taskId, updates);
      } catch (err) {
        this.tasks.warnQuietly(this.taskId, err as Error);
      }
    }
    this.writing = undefined;
  }

  /** 等在途的进度写完，再写终态，日志和 SSE 的顺序才是对的 */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }
}

/** 产物必须是 root（输出目录，或 pipeline 中间步骤在 workDir 里的目录）里真实存在的文件，路径去重；primary 必须在 files 里 */
async function verifyOutputs(
  result: OperationResult,
  root: string,
): Promise<{ files: string[]; primary?: string }> {
  if (!result || !Array.isArray(result.files)) throw new Error('操作没有返回产物列表（files）');
  const files = [...new Set(result.files.map((f) => path.resolve(f)))];
  for (const file of files) {
    if (!isInside(root, file)) {
      throw new Error(`产物不在输出目录内: ${path.basename(file)}`);
    }
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`产物文件不存在: ${relativeOutputPath(file, root)}`);
  }
  if (result.primary === undefined) return { files, primary: files[0] };
  const primary = path.resolve(result.primary);
  if (!files.includes(primary)) throw new Error('主产物（primary）不在产物列表（files）里');
  return { files, primary };
}

/** root 是产物存储时所在的目录（workDir 里的暂存目录），name 是相对它的路径，移进输出目录后不变 */
function toTaskOutput(stored: StoredOutput, root: string): TaskOutput {
  return {
    name: relativeOutputPath(stored.path, root),
    url: stored.url,
    size: stored.size,
    contentType: stored.contentType,
    storage: stored.storage,
    ...(stored.key ? { key: stored.key } : {}),
  };
}

const MOVE_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Windows 上杀毒软件、索引服务会短暂占着刚写完的文件，改名报 EPERM / EBUSY，稍等重试即可 */
async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !MOVE_RETRY_CODES.has(code) || attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * 移动一个文件或目录。同一文件系统上是一次原子的改名；跨文件系统（EXDEV）时先复制到 partialRoot
 * （输出目录里以点开头、不会被下载的目录），复制完再改名到目标位置，中途被杀也不会在输出目录里留下能下载的半截文件
 */
async function moveEntry(src: string, dest: string, partialRoot: string): Promise<void> {
  try {
    await renameWithRetry(src, dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code !== 'EXDEV' && !MOVE_RETRY_CODES.has(code)) throw err;
  }
  const temp = path.join(partialRoot, path.basename(src));
  await fs.promises.mkdir(partialRoot, { recursive: true });
  await fs.promises.rm(temp, { recursive: true, force: true });
  await fs.promises.cp(src, temp, { recursive: true, errorOnExist: true, force: false });
  await fs.promises.rename(temp, dest);
  await fs.promises.rm(src, { recursive: true, force: true }).catch(() => {});
}

/**
 * 把最后一步写在暂存目录（stagingRoot）里的产物移进输出目录 outputRoot，相对路径不变。
 * outputPath 分配的文件和 outputDir 分配的目录各是暂存目录下的一个顶层条目，整个移过去：
 * HLS 这类目录产物里的每个文件都在原来的相对位置。存储后已不在本地的（S3 删掉了本地副本）不移。
 * 返回移进输出目录的顶层条目，之后任务失败或被取消时由调用方删除；中途失败时已移过去的会先删掉
 */
export async function publishOutputs(
  files: readonly string[],
  stagingRoot: string,
  outputRoot: string,
  taskId: string,
): Promise<string[]> {
  const tops = new Set<string>();
  for (const file of files) {
    if (!isInside(stagingRoot, file)) continue;
    const exists = await fs.promises.stat(file).then(
      () => true,
      () => false,
    );
    if (exists) tops.add(path.relative(stagingRoot, file).split(path.sep)[0]);
  }
  const partialRoot = path.join(outputRoot, PARTIAL_DIR, taskId);
  const published: string[] = [];
  try {
    for (const top of tops) {
      const dest = path.join(outputRoot, top);
      await moveEntry(path.join(stagingRoot, top), dest, partialRoot);
      published.push(dest);
    }
    return published;
  } catch (err) {
    await removePaths(published);
    throw new Error(`保存产物到输出目录失败: ${errorMessage(err)}`, { cause: err });
  } finally {
    await fs.promises.rm(partialRoot, { recursive: true, force: true }).catch(() => {});
  }
}

interface JobDeps {
  tasks: TaskService;
  getOperation: GetOperation;
  storeOutputs: StoreOutputs;
  cancelPollMs: number;
}

/** pipeline 合并下载时各步骤输入槽的键，避免不同步骤的同名槽互相覆盖 */
const slotKey = (step: number, slot: string) => `${step}/${slot}`;

async function processJob(
  job: Job<QueuedJobData>,
  signal: AbortSignal | undefined,
  deps: JobDeps,
): Promise<{ files: number } | undefined> {
  const { tasks } = deps;
  const data = job.data;
  const taskId = data.taskId;
  const log = (message: string) => console.log(`[Task:${taskId}] ${message}`);
  if (typeof taskId !== 'string' || !SAFE_TASK_ID.test(taskId)) {
    throw new Error('任务数据不合法：taskId 格式不对');
  }
  const uploads = jobUploadPaths(data);

  const plan = resolveJob(data, deps.getOperation);
  if ('error' in plan) {
    log(plan.error);
    try {
      await tasks.finish(taskId, { status: 'failed', error: plan.error });
    } finally {
      await removePaths(uploads);
    }
    throw new Error(plan.error);
  }

  const { steps, pipeline } = plan;
  // 取消有三条路：本进程的 cancelJob、取消广播（都经 BullMQ 的 signal），以及下面定时查任务状态的兜底
  const watchdog = new AbortController();
  const abortSignal = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
  const workDir = workDirOf(taskId);
  const partialDir = partialDirOf(taskId);
  const hasDownloads = steps.some((step) => countUrlInputs(step.inputs) > 0);
  const downloadShare = pipeline ? 0.3 : (steps[0].op.downloadShare ?? 0.3);
  const share = hasDownloads ? Math.min(0.9, Math.max(0, downloadShare)) : 0;
  const reporter = new ProgressReporter(tasks, taskId, log);
  const startedAt = Date.now();
  const stepStates: PipelineStep[] | undefined = pipeline
    ? steps.map((step) => ({ op: step.op.name, status: 'pending' }))
    : undefined;
  let current = -1;
  // 上传完才发现任务已被取消时，对象存储里的对象没人引用，要一并删掉
  let stored: StoredOutput[] | undefined;
  // 已经移进输出目录的产物（顶层文件或目录），之后失败或被取消时删除
  let published: string[] | undefined;
  let poll: NodeJS.Timeout | undefined;

  const markStep = (index: number, status: PipelineStepStatus) => {
    if (!stepStates) return;
    stepStates[index] = { ...stepStates[index], status };
    reporter.write({ steps: stepStates.map((s) => ({ ...s })) });
  };

  try {
    const firstPhase: TaskPhase = hasDownloads ? 'downloading' : 'processing';
    // 不写 progress: 0：新任务本来就是 0；进程崩溃后被重新执行的任务保留上次的进度（文档承诺只增不减）
    const begun = await tasks.update(taskId, { status: 'processing', phase: firstPhase });
    if (!begun) {
      // 排队期间已被取消，或任务记录已过期：没人能看到结果，不必执行
      log('任务已结束或记录已过期，跳过执行');
      return undefined;
    }
    poll = setInterval(() => {
      tasks
        .get(taskId)
        .then((latest: Task | undefined) => {
          if (latest && !isTerminal(latest.status)) return;
          watchdog.abort(latest?.error ?? '任务记录已不存在');
        })
        .catch(() => {});
    }, deps.cancelPollMs);
    reporter.start(firstPhase, begun.progress);
    log(
      pipeline
        ? `开始执行 pipeline: ${steps.map((s) => s.op.name).join(' → ')}`
        : `开始执行 ${steps[0].op.name}`,
    );
    // 进程崩溃后被重新执行的 job 可能留下了上一次的目录（含写了一半的产物）和复制到一半的产物
    await removePaths([workDir, partialDir]);
    await fs.promises.mkdir(workDir, { recursive: true });

    // 所有步骤的链接输入一次下载完：中途才发现链接失效的话，前面几步的处理就白做了
    const slots: MaterializeSlot[] = steps.flatMap((step, i) =>
      step.op.inputs.map((slot) => ({
        name: slotKey(i, slot.name),
        kind: slot.kind,
        label: slot.name,
      })),
    );
    const flat: JobInputs = {};
    steps.forEach((step, i) => {
      for (const [name, items] of Object.entries(step.inputs)) flat[slotKey(i, name)] = items;
    });
    // 旧版 compose 在下载阶段就汇报 totalVideos / currentVideoIndex（文档里写了），多视频输入的操作沿用：
    // 完成顺序不分视频和音乐，已完成数截到视频总数为止
    const videoSlot = pipeline
      ? undefined
      : steps[0].op.inputs.find((s) => s.multiple && s.kind === 'video');
    const videoCount = videoSlot ? (steps[0].inputs[videoSlot.name]?.length ?? 0) : 0;
    const downloadExtra = (done: number): ProgressExtra | undefined =>
      videoCount
        ? { currentVideoIndex: Math.min(done, videoCount), totalVideos: videoCount }
        : undefined;
    const local = await materializeInputs(slots, flat, workDir, {
      signal: abortSignal,
      onDownloaded: (done, total) => reporter.report((share * done) / total, downloadExtra(done)),
      log,
    });
    reporter.report(share, { phase: 'processing' });

    const per = (STORE_START - share) / steps.length;
    let previous: string | undefined;
    // 最后一步的产物所在的暂存目录（workDir 里）
    let stagingRoot = workDir;
    let result: OperationResult = { files: [] };
    let verified: { files: string[]; primary?: string } = { files: [] };
    for (const [i, step] of steps.entries()) {
      current = i;
      const last = i === steps.length - 1;
      const inputs: Record<string, string[]> = {};
      for (const slot of step.op.inputs) {
        const files = local[slotKey(i, slot.name)];
        if (files?.length) inputs[slot.name] = files;
      }
      if (previous) inputs.file = [previous];
      // pipeline 的每一步用自己的工作目录（操作会在 workDir 里写固定名字的临时文件）。
      // 所有步骤（包括最后一步）的产物都写在 workDir 里，最后一步的产物全部完成并校验后才移进输出目录
      const stepDir = pipeline ? path.join(workDir, `step-${i + 1}`) : workDir;
      const outputRoot = pipeline
        ? path.join(workDir, `step-${i + 1}-output`)
        : path.join(workDir, STAGING_DIR);
      await fs.promises.mkdir(outputRoot, { recursive: true });
      if (pipeline) {
        await fs.promises.mkdir(stepDir, { recursive: true });
        markStep(i, 'processing');
        if (i > 0) reporter.report(share + i * per, { phase: 'processing' });
        log(`第 ${i + 1}/${steps.length} 步: ${step.op.name}`);
      }
      const base = share + i * per;
      const ctx = createOperationContext({
        taskId,
        inputs,
        workDir: stepDir,
        outputRoot,
        signal: abortSignal,
        onProgress: (fraction, extra) => reporter.report(base + fraction * per, extra),
        onLog: pipeline ? (message) => log(`[${i + 1}:${step.op.name}] ${message}`) : log,
      });
      if (last) stagingRoot = outputRoot;
      try {
        result = await step.op.run(ctx, step.params);
        abortSignal.throwIfAborted();
        verified = await verifyOutputs(result, outputRoot);
        if (!last && !verified.primary) throw new Error('没有产出文件，无法作为下一步的输入');
      } catch (err) {
        // pipeline 的失败信息带上步骤，客户端才知道是哪一步出错；取消原因原样保留
        if (pipeline && !abortSignal.aborted) {
          throw new Error(`第 ${i + 1} 步（${step.op.name}）: ${errorMessage(err)}`, {
            cause: err,
          });
        }
        throw err;
      }
      previous = verified.primary;
      markStep(i, 'completed');
    }

    const { files, primary } = verified;
    // 只有真的要上传到对象存储时才进入 uploading；本地存储保留操作自己的最后一个阶段（compose 是 merging），
    // 与旧版文档一致
    reporter.report(STORE_START, storageDriver() === 's3' ? { phase: 'uploading' } : {});
    // 直接从暂存目录存储：相对路径（下载地址、S3 key）和移进输出目录后一样；S3 删掉本地副本后就不用再移
    stored = await deps.storeOutputs(files, {
      taskId,
      signal: abortSignal,
      settings: { ...defaultStorageSettings(), outputRoot: stagingRoot },
    });
    abortSignal.throwIfAborted();
    published = await publishOutputs(files, stagingRoot, config.outputDir, taskId);
    abortSignal.throwIfAborted();
    const outputs = stored.map((s) => toTaskOutput(s, stagingRoot));
    const primaryStored = stored.find((s) => path.resolve(s.path) === primary) ?? stored[0];
    // 旧字段 output 只给输出目录里的相对路径（旧客户端取的是文件名），不暴露服务器目录
    const names = files.map((file) => relativeOutputPath(file, stagingRoot));

    await reporter.flush();
    const done = await tasks.finish(taskId, {
      status: 'completed',
      ...(names.length ? { output: names.join(',') } : {}),
      outputs,
      ...(primaryStored ? { primaryUrl: primaryStored.url } : {}),
      ...(result.data !== undefined ? { result: result.data } : {}),
      ...(stepStates ? { steps: stepStates } : {}),
    });
    if (!done) {
      // 执行期间任务被别处置为终态（取消接口），产物没人会来取
      log('任务在完成前已被取消，删除产物');
      await deleteStoredOutputs(stored, { taskId });
      await removePaths(published);
      return undefined;
    }
    log(`完成，${files.length} 个产物，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return { files: files.length };
  } catch (err) {
    // 已上传的对象、已移进输出目录的产物，以及 workDir 里暂存的半截产物，都在写终态之前删掉：
    // 客户端看到 failed / cancelled 时现场已经干净（finally 里再删一次上传文件等，重复删没有影响）
    if (stored) await deleteStoredOutputs(stored, { taskId });
    if (published) await removePaths(published);
    await removePaths([workDir, partialDir]);
    const cancelled = abortSignal.aborted;
    const message = cancelled ? cancelMessage(abortSignal.reason) : errorMessage(err);
    if (stepStates && current >= 0) {
      stepStates[current] = { ...stepStates[current], status: cancelled ? 'cancelled' : 'failed' };
    }
    await reporter.flush();
    try {
      await tasks.finish(taskId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: message,
        ...(stepStates ? { steps: stepStates } : {}),
      });
    } catch (updateErr) {
      console.error(`[Task:${taskId}] 写入终态失败: ${errorMessage(updateErr)}`);
    }
    log(cancelled ? `已取消: ${message}` : `失败: ${message}`);
    throw err instanceof Error && !cancelled ? err : new Error(message);
  } finally {
    clearInterval(poll);
    await removePaths([workDir, partialDir, ...uploads]);
  }
}

export interface TaskWorkerOptions {
  operations: readonly AnyOperation[];
  tasks?: TaskService;
  /** 默认按 config.redisUrl 新建连接（maxRetriesPerRequest 必须为 null） */
  connection?: IORedis;
  prefix?: string;
  concurrency?: number;
  /** 默认 storage.service 的 storeOutputs，测试可以替换 */
  storeOutputs?: StoreOutputs;
  /** 默认 true */
  autorun?: boolean;
  /** 执行中定时查任务状态的间隔（取消广播的兜底），默认 5 秒 */
  cancelPollMs?: number;
  /** BullMQ 的锁和卡死检测参数，默认用 BullMQ 的（锁 30 秒）。测试进程被杀后的重新执行时调小 */
  stalled?: Pick<WorkerOptions, 'lockDuration' | 'stalledInterval' | 'maxStalledCount'>;
}

export function createTaskWorker(opts: TaskWorkerOptions): TaskWorker {
  const tasks = opts.tasks ?? defaultTaskService;
  const byName = new Map(opts.operations.map((op) => [op.name, op]));
  const deps: JobDeps = {
    tasks,
    getOperation: (name) => byName.get(name),
    storeOutputs: opts.storeOutputs ?? defaultStoreOutputs,
    cancelPollMs: opts.cancelPollMs ?? CANCEL_POLL_MS,
  };

  const worker = new Worker<QueuedJobData>(
    QUEUE_NAME,
    // BullMQ 按处理函数的参数个数（length >= 3）决定是否创建取消用的 AbortController，
    // signal 参数必须写出来，worker.cancelJob(jobId) 才能中止 ffmpeg
    (job, _token, signal) => processJob(job, signal, deps),
    {
      // BullMQ Worker 的阻塞连接要求 maxRetriesPerRequest 为 null
      connection: opts.connection ?? createRedis('worker', { maxRetriesPerRequest: null }),
      concurrency: opts.concurrency ?? config.maxConcurrentTasks,
      autorun: opts.autorun ?? true,
      ...(opts.prefix ? { prefix: opts.prefix } : {}),
      ...opts.stalled,
    },
  );

  // 兜底：处理函数之外的失败（锁丢失、job 卡死超过上限）也要把任务写成终态；已是终态时 finish 什么都不做
  worker.on('failed', (job, err) => {
    const taskId = job?.data?.taskId;
    if (!job || typeof taskId !== 'string') return;
    tasks.finish(taskId, { status: 'failed', error: err.message }).catch((updateErr) => {
      console.error(`[Task:${taskId}] 写入失败状态出错: ${errorMessage(updateErr)}`);
    });
    // 执行它的进程被杀、卡死次数超过上限的 job 不会再走 processJob 的清理：工作目录（含写了一半的产物）、
    // 上传文件和复制到一半的产物在这里删。处理函数自己失败时这些已经删过了，再删一次没有影响
    if (SAFE_TASK_ID.test(taskId)) {
      void removePaths([workDirOf(taskId), partialDirOf(taskId), ...jobUploadPaths(job.data)]);
    }
  });
  worker.on('error', throttledLogger('BullMQ Worker Error'));

  // 订阅模式的连接不能再发普通命令，取消广播单独用一条连接，随 Worker 关闭
  const subscriber = opts.connection
    ? opts.connection.duplicate()
    : createRedis('cancel', { maxRetriesPerRequest: null });
  if (opts.connection) subscriber.on('error', throttledLogger('Redis:cancel'));
  const channel = cancelChannel(worker.qualifiedName);
  subscribeCancels(subscriber, channel, ({ jobId, reason }) => {
    // 每个实例都会收到，只有正在跑这个 job 的那个 cancelJob 返回 true
    if (worker.cancelJob(jobId, reason || DEFAULT_CANCEL_REASON)) {
      console.log(`[Task:${jobId}] 收到取消广播，中止执行`);
    }
  }).catch((err: Error) => console.error(`[Redis:cancel] 订阅取消频道失败: ${err.message}`));
  worker.on('closed', () => subscriber.disconnect());
  return worker;
}

/** cancelTask 用到的队列能力。广播走 TaskService 的连接（BullMQ 6 的客户端封装没有 publish） */
export type CancelQueue = Pick<JobQueue, 'getJob' | 'remove' | 'qualifiedName'>;

export type CancelOutcome =
  | { kind: 'not-found' }
  /** 已是终态，不能取消 */
  | { kind: 'terminal'; task: Task }
  /** removed：job 还在排队，已从队列删除；否则 job 正在执行（或已不在队列），已广播取消 */
  | { kind: 'cancelled'; task: Task; removed: boolean };

/**
 * 取消任务。先原子地把任务写成 cancelled（之后 Worker 的进度和完成都写不进去，回调由终态事件触发），
 * 再处理 job：还在排队就从队列删掉并清理上传文件；正在执行就广播给所有 Worker，跑着它的那个中止 ffmpeg、
 * 下载和上传，自己清理现场。广播失败不影响结果，Worker 定时查状态时也会停下
 */
export async function cancelTask(
  id: string,
  deps: { tasks: TaskService; queue: CancelQueue; queueTimeoutMs?: number },
  reason: string = DEFAULT_CANCEL_REASON,
): Promise<CancelOutcome> {
  const { tasks, queue } = deps;
  const task = await tasks.get(id);
  if (!task) return { kind: 'not-found' };
  if (isTerminal(task.status)) return { kind: 'terminal', task };

  const finished = await tasks.finish(id, { status: 'cancelled', error: reason });
  if (!finished) {
    const latest = await tasks.get(id);
    return latest ? { kind: 'terminal', task: latest } : { kind: 'not-found' };
  }

  // 任务已经是 cancelled，下面只是尽快停下 job。队列一时连不上就当作找不到 job：走广播，
  // Worker 定时查状态时也会停下，排队中的 job 开始执行时看到终态会直接跳过
  const job = await withQueueTimeout(queue.getJob(id), deps.queueTimeoutMs).catch(() => undefined);
  let removed = false;
  if (job) {
    // 1 表示删掉了（等待、延迟中的 job）；0 表示被 Worker 锁住，正在执行
    removed = (await withQueueTimeout(queue.remove(id), deps.queueTimeoutMs).catch(() => 0)) === 1;
    if (removed) await removePaths(jobUploadPaths(job.data));
  }
  if (!removed) {
    try {
      await publishCancel(tasks, cancelChannel(queue.qualifiedName), { jobId: id, reason });
    } catch (err) {
      console.error(`[Task:${id}] 广播取消失败（Worker 会在定时检查时停下）: ${errorMessage(err)}`);
    }
  }
  return { kind: 'cancelled', task: finished, removed };
}
