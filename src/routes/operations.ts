import fs from 'fs';
import path from 'path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { OperationInfo } from '../core/catalog';
import { createOperationContext, type CreatedContext } from '../core/context';
import {
  assertPublicUrls,
  downloadErrorToHttp,
  materializeInputs,
  resolveRequestInputs,
  takeCallbackUrl,
  type JobInputs,
} from '../core/inputs';
import { normalizeRawParams } from '../core/params';
import { HttpError, sendServerError } from '../middleware/error';
import {
  createUploadMiddleware,
  removeUploadedFiles,
  uploadedFilesBySlot,
} from '../middleware/upload';
import { formatIssues } from '../middleware/validate';
import type { AnyOperation } from '../operations/types';
import {
  STAGING_DIR,
  withQueueTimeout,
  type JobQueue,
  type SubmittedJobData,
} from '../services/queue.service';
import type { TaskService } from '../services/task.service';
import type { PipelineStep } from '../types';

/** 同步接口（/api/info）同时执行的请求数和排队等空位的请求数上限 */
export interface SyncLimits {
  concurrency: number;
  queue: number;
}

/**
 * 默认的同步并发：同步接口只有 /api/info（ffprobe，很轻），按任务并发数放宽，至少 8 个；
 * 再多的排队等空位（每个并发位 8 个），排队也满了才 429
 */
export function defaultSyncLimits(): SyncLimits {
  const concurrency = config.syncMaxConcurrency || Math.max(8, config.maxConcurrentTasks * 2);
  return { concurrency, queue: concurrency * 8 };
}

export interface OperationRouteDeps {
  tasks: TaskService;
  queue: Pick<JobQueue, 'add' | 'getJobCounts'>;
  /** 入队和查队列长度的超时，默认 QUEUE_COMMAND_TIMEOUT_MS */
  queueTimeoutMs?: number;
  /** 默认 defaultSyncLimits() */
  syncLimits?: SyncLimits;
}

interface PreparedRequest {
  inputs: JobInputs;
  urls: string[];
  params: Record<string, unknown>;
  callbackUrl?: string;
}

/** 请求体 → 输入、callbackUrl、校验过的参数。不合格时抛 HttpError(400) */
function prepare(op: AnyOperation, req: Request): PreparedRequest {
  const raw: unknown = req.body;
  if (Array.isArray(raw)) throw new HttpError(400, '请求体必须是 JSON 对象');
  // Express 5 没有请求体时 req.body 是 undefined；multer 给的是无原型对象，复制一份再删字段
  const body: Record<string, unknown> = { ...((raw as Record<string, unknown>) ?? {}) };
  const paramKeys = new Set(Object.keys(op.params.shape));
  const { inputs, provided, urls } = resolveRequestInputs(
    op.inputs,
    paramKeys,
    uploadedFilesBySlot(req),
    body,
  );
  const callbackUrl = takeCallbackUrl(body);
  const parsed = op.params.safeParse(normalizeRawParams(body));
  if (!parsed.success) throw new HttpError(400, formatIssues(parsed.error.issues));
  const params = parsed.data as Record<string, unknown>;
  const problem = op.check?.(params, provided);
  if (problem) throw new HttpError(400, problem);
  return { inputs, urls, params, ...(callbackUrl ? { callbackUrl } : {}) };
}

/** HttpError 交给 errorHandler（统一记日志），其余错误按 Redis 不可用 503 / 500 返回 */
export function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof HttpError) return next(err);
  sendServerError(res, err);
}

export interface NewJob {
  /** 任务 type 和 BullMQ job 名 */
  name: string;
  payload(taskId: string): SubmittedJobData;
  callbackUrl?: string;
  /** pipeline 的初始步骤状态 */
  steps?: PipelineStep[];
}

/** 检查队列长度 → 建任务记录 → 入队（jobId 等于 taskId）→ 回复 taskId。单个操作和 pipeline 共用 */
export async function enqueueTask(
  req: Request,
  res: Response,
  deps: OperationRouteDeps,
  job: NewJob,
): Promise<void> {
  // 队列的连接从未就绪（Redis 在进程启动时就不可用）时 BullMQ 的命令会一直等下去，不加超时的话
  // 提交请求挂到 Redis 恢复为止，上传文件也一直占着磁盘
  if (config.maxQueueLength > 0) {
    const counts = await withQueueTimeout(
      deps.queue.getJobCounts('waiting', 'delayed', 'prioritized'),
      deps.queueTimeoutMs,
    );
    const queued = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
    if (queued >= config.maxQueueLength) throw new HttpError(429, '任务队列已满，请稍后重试');
  }
  const task = await deps.tasks.create(job.name, {
    callbackUrl: job.callbackUrl,
    ...(job.steps ? { steps: job.steps } : {}),
  });
  // 上传文件从这里起归任务所有，由 Worker 在任务结束后删除。先标记再入队：
  // 客户端在入队期间断开时，请求结束的清理不能删掉 Worker 马上要读的文件
  res.locals.keepUploads = true;
  try {
    // 超时后这个 add 可能在 Redis 恢复时才真正写进去：任务记录已经删了，Worker 开始执行时会直接跳过
    await withQueueTimeout(
      deps.queue.add(job.name, job.payload(task.id), { jobId: task.id }),
      deps.queueTimeoutMs,
    );
  } catch (err) {
    res.locals.keepUploads = false;
    removeUploadedFiles(req);
    // 客户端拿不到这个 taskId，记录留着只会一直停在 pending 直到过期；也不能 finish，那会给 callbackUrl 发一个
    // 客户端不认识的 task.failed
    await deps.tasks.remove(task.id).catch(() => {});
    throw err;
  }
  res.json({ success: true, data: { taskId: task.id, status: task.status } });
}

const SYNC_BUSY = '同步请求过多，请稍后重试';

/**
 * 同步接口的并发闸门。并发满了的请求排队等空位，而不是立刻 429：旧版 /api/info 不限并发，
 * 批量探测的客户端会并行发十几个请求，也不会重试 429。排队的请求数也有上限，超过才 429
 */
export class SyncGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limits: SyncLimits) {}

  /** 拿到空位后返回释放函数（多次调用只生效一次）。排队已满时抛 429；signal 取消时以 signal.reason 拒绝 */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limits.concurrency) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.limits.queue) {
      return Promise.reject(new HttpError(429, SYNC_BUSY));
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(this.releaser());
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(grant);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // 空位直接交给排在最前面的请求，active 不变
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

async function runSync(
  op: AnyOperation,
  req: Request,
  res: Response,
  prepared: PreparedRequest,
  gate: SyncGate,
): Promise<void> {
  // 上传文件由这里在执行结束后删除；请求结束的清理在客户端断开时就会触发，那时 ffmpeg 可能还开着文件
  res.locals.keepUploads = true;

  const controller = new AbortController();
  const seconds = Number((config.syncTimeoutMs / 1000).toFixed(1));
  const timer = setTimeout(
    () => controller.abort(new HttpError(504, `处理超时：同步接口最长执行 ${seconds} 秒`)),
    config.syncTimeoutMs,
  );
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new HttpError(499, '客户端已断开连接'));
  };
  res.on('close', onClose);

  const id = `sync-${uuidv4()}`;
  const workDir = path.join(config.uploadDir, id);
  // 出错时 errorHandler 把这个目录整体去掉，下载下来的输入在错误信息里只剩文件名（input-0.txt）
  res.locals.redactRoots = [workDir];
  let ctx: CreatedContext | undefined;
  let release: (() => void) | undefined;
  let cleaned = false;
  // 同步接口没有任务记录，产物没人能取，一律删除。成功时在回复之前清理，客户端拿到响应时现场已经干净
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const leftovers = [workDir, ...(ctx?.allocated ?? [])];
    await Promise.all(
      leftovers.map((p) => fs.promises.rm(p, { recursive: true, force: true }).catch(() => {})),
    );
    removeUploadedFiles(req);
  };
  try {
    // 不排队的话一批请求就能同时拉起几十个 ffprobe / 下载；等空位的时间算在同步超时里
    release = await gate.acquire(controller.signal);
    // 产物（同步接口最后都会删掉）也写在 workDir 里，进程中途被杀时不会留在输出目录
    const outputRoot = path.join(workDir, STAGING_DIR);
    await fs.promises.mkdir(outputRoot, { recursive: true });
    const local = await materializeInputs(op.inputs, prepared.inputs, workDir, {
      signal: controller.signal,
      log: (message) => console.log(`[${op.name}:${id}] ${message}`),
    });
    ctx = createOperationContext({
      taskId: id,
      inputs: local,
      workDir,
      outputRoot,
      signal: controller.signal,
      onLog: (message) => console.log(`[${op.name}:${id}] ${message}`),
    });
    const result = await op.run(ctx, prepared.params);
    controller.signal.throwIfAborted();
    await cleanup();
    res.json({ success: true, data: result.data ?? null });
  } catch (err) {
    // ffmpeg / ffprobe 被中止时以 signal.reason 拒绝，超时就是上面的 504
    const reason = controller.signal.aborted ? controller.signal.reason : err;
    if (res.destroyed || res.writableEnded) {
      console.warn(`[${op.name}:${id}] 客户端已断开，放弃执行`);
      return;
    }
    // 排队一直没等到空位就到了同步超时：请求根本没有执行，按繁忙回复，客户端稍后重试即可
    if (!release && reason instanceof HttpError && reason.status === 504) {
      throw new HttpError(429, SYNC_BUSY);
    }
    throw downloadErrorToHttp(reason);
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
    release?.();
    await cleanup();
  }
}

/** 为每个操作注册 POST op.route：multipart 上传或 URL 输入 → 参数校验 → 入队（同步操作直接执行） */
export function createOperationRouter(
  operations: readonly AnyOperation[],
  deps: OperationRouteDeps,
): Router {
  const router = Router();
  const gate = new SyncGate(deps.syncLimits ?? defaultSyncLimits());

  for (const op of operations) {
    router.post(
      op.route,
      createUploadMiddleware(op.inputs),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const prepared = prepare(op, req);
          const urls = [...prepared.urls, ...(prepared.callbackUrl ? [prepared.callbackUrl] : [])];
          await assertPublicUrls(urls);
          if (op.sync) {
            await runSync(op, req, res, prepared, gate);
            return;
          }
          const { inputs, params, callbackUrl } = prepared;
          await enqueueTask(req, res, deps, {
            name: op.name,
            callbackUrl,
            payload: (taskId) => ({
              taskId,
              op: op.name,
              inputs,
              params,
              ...(callbackUrl ? { callbackUrl } : {}),
            }),
          });
        } catch (err) {
          fail(res, next, err);
        }
      },
    );
  }
  return router;
}

/** GET /api/operations 与 /api/operations/:name。catalog 由 app 在启动时算好（参数 JSON Schema 只算一次） */
export function createCatalogRouter(catalog: readonly OperationInfo[]): Router {
  const router = Router();
  const byName = new Map(catalog.map((item) => [item.name, item]));
  router.get('/', (_req, res) => {
    res.json({ success: true, data: catalog });
  });
  router.get('/:name', (req, res) => {
    const item = byName.get(req.params.name);
    if (!item) {
      res
        .status(404)
        .json({ success: false, error: `操作不存在: ${req.params.name.slice(0, 64)}` });
      return;
    }
    res.json({ success: true, data: item });
  });
  return router;
}
