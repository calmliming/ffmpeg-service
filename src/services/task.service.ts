import { EventEmitter } from 'events';
import path from 'path';
import type IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { redactForClient } from '../middleware/error';
import { createRedis } from '../utils/redis';
import { encodeUrlPath } from './storage.service';
import type {
  PipelineStep,
  Task,
  TaskCallback,
  TaskOutput,
  TaskStatus,
  TerminalStatus,
} from '../types';

/** 非终态更新：进度、阶段、片段序号；status 只能是 pending / processing（传终态会转给 finish） */
export type TaskUpdates = Partial<
  Pick<
    Task,
    | 'status'
    | 'progress'
    | 'phase'
    | 'currentVideoIndex'
    | 'totalVideos'
    | 'error'
    | 'output'
    | 'outputs'
    | 'primaryUrl'
    | 'result'
    | 'steps'
  >
>;

export interface TerminalUpdates {
  status: TerminalStatus;
  /** 默认 completed 为 100，failed / cancelled 保持当前进度 */
  progress?: number;
  error?: string;
  output?: string;
  outputs?: TaskOutput[];
  primaryUrl?: string;
  result?: unknown;
  steps?: PipelineStep[];
}

export interface TaskServiceOptions {
  /** 默认按 config.redisUrl 在第一次使用时建立连接 */
  redis?: IORedis;
  /** 默认 task: */
  keyPrefix?: string;
  /** 默认 config.taskTtlSeconds */
  ttlSeconds?: number;
}

export function isTerminal(status: TaskStatus): status is TerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// 比较后写入（CAS）：只有 Redis 里的值仍是读出时的那份才写，否则说明期间有别的写入，调用方重读后重试。
// 用 Lua 而不是 WATCH / MULTI：WATCH 绑在连接上，共用一个 ioredis 连接的并发请求会互相打断
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;
const MAX_CAS_ATTEMPTS = 20;

function serialize(task: Task): string {
  return JSON.stringify(task);
}

function deserialize(raw: string): Task {
  const obj = JSON.parse(raw);
  if (obj.createdAt) obj.createdAt = new Date(obj.createdAt);
  if (obj.startedAt) obj.startedAt = new Date(obj.startedAt);
  if (obj.completedAt) obj.completedAt = new Date(obj.completedAt);
  if (obj.callback?.deliveredAt) obj.callback.deliveredAt = new Date(obj.callback.deliveredAt);
  return obj as Task;
}

const isAbsolutePath = (file: string) => path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file);

/**
 * 旧字段 output 里的产物名（逗号分隔）。现在记的是输出目录里的相对路径；更早的记录是服务器上的绝对路径，
 * 换成相对路径（不在输出目录里的只留文件名），不暴露服务器目录结构。旧客户端取的是文件名，两种写法都一样
 */
function outputNames(output: string): string[] {
  return output
    .split(',')
    .filter(Boolean)
    .map((file) => {
      if (!isAbsolutePath(file)) return file;
      const rel = path.relative(config.outputDir, file);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join('/');
      }
      return file.split(/[\\/]/).pop() ?? '';
    });
}

/**
 * 失败原因来自 ffmpeg、下载、存储等各处的报错，可能带服务器目录；取消原因是调用方自己写的，不改。
 * 任务的工作目录（uploads/<taskId>）整体去掉，里面的下载文件、临时文件只留文件名
 */
function clientError(task: Pick<Task, 'id' | 'status'>, error: string): string {
  if (task.status === 'cancelled') return error;
  return redactForClient(error, [path.join(config.uploadDir, task.id)]);
}

/**
 * GET /api/tasks/:id、SSE 和回调里给客户端看的任务对象：
 * 去掉旧版本记录里的 inputFiles（服务器路径），output 和 error 里不出现服务器目录，补上 elapsedSeconds 和 downloadUrl
 */
export function taskView(task: Task, now: Date = new Date()): Record<string, unknown> {
  const data: Record<string, unknown> = { ...task };
  delete data.inputFiles;
  if (task.output) data.output = outputNames(task.output).join(',');
  if (task.error) data.error = clientError(task, task.error);
  if (task.startedAt) {
    const end = task.completedAt ?? now;
    data.elapsedSeconds = Math.max(
      0,
      Math.floor((end.getTime() - task.startedAt.getTime()) / 1000),
    );
  }
  // downloadUrl 是旧客户端的字段，文档说拼上服务地址就能下载：本地产物始终给 /api/files/… 相对路径，
  // 配置了 PUBLIC_BASE_URL 也不变（绝对地址在 outputs[].url 和 primaryUrl 里）；S3 地址本来就是完整的
  if (task.outputs?.length) {
    data.downloadUrl = task.outputs.map((o) =>
      o.storage === 'local' ? `/api/files/${encodeUrlPath(o.name)}` : o.url,
    );
  } else if (task.output) {
    // 升级前完成的任务只有 output，产物都在输出目录顶层
    data.downloadUrl = outputNames(task.output).map((name) => `/api/files/${encodeUrlPath(name)}`);
  }
  return data;
}

export class TaskService {
  private client?: IORedis;
  private readonly emitter = new EventEmitter();
  private readonly keyPrefix: string;
  private lastQuietWarn = 0;

  constructor(private readonly opts: TaskServiceOptions = {}) {
    this.keyPrefix = opts.keyPrefix ?? 'task:';
    // 每个 SSE 连接一个监听器，外加回调分发器
    this.emitter.setMaxListeners(0);
  }

  // 连接在第一次使用时才建立：import 本模块不会连 Redis，测试可以先改 config.redisUrl
  private get redis(): IORedis {
    // 默认的 maxRetriesPerRequest: null 会让命令在 Redis 不可用时无限排队，
    // 查询任务的 HTTP 请求一直挂到客户端超时（2026-10-26 实测），这里改成几秒内失败
    this.client ??=
      this.opts.redis ??
      createRedis('tasks', { maxRetriesPerRequest: 2, connectTimeout: 3000, commandTimeout: 5000 });
    return this.client;
  }

  private key(id: string): string {
    return `${this.keyPrefix}${id}`;
  }

  private get ttl(): number {
    return this.opts.ttlSeconds ?? config.taskTtlSeconds;
  }

  async create(
    type: string,
    extra: { callbackUrl?: string; steps?: PipelineStep[] } = {},
  ): Promise<Task> {
    const task: Task = {
      id: uuidv4(),
      status: 'pending',
      progress: 0,
      type,
      createdAt: new Date(),
      ...(extra.steps ? { steps: extra.steps } : {}),
      ...(extra.callbackUrl ? { callbackUrl: extra.callbackUrl } : {}),
    };
    await this.redis.set(this.key(task.id), serialize(task), 'EX', this.ttl);
    return task;
  }

  async get(id: string): Promise<Task | undefined> {
    const raw = await this.redis.get(this.key(id));
    return raw ? deserialize(raw) : undefined;
  }

  /** 删除任务记录。只用于入队失败、客户端从未拿到 taskId 的任务，不触发任何事件 */
  async remove(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }

  /**
   * 读出 → 修改 → 比较后写入，冲突时重读重试。mutator 返回 undefined 表示不需要改动。
   * 返回写入后的任务；任务不存在或没有改动时返回 undefined
   */
  private async mutate(id: string, mutator: (task: Task) => Task | undefined) {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const raw = await this.redis.get(this.key(id));
      if (!raw) return undefined;
      const next = mutator(deserialize(raw));
      if (!next) return undefined;
      const result = await this.redis.eval(
        COMPARE_AND_SET,
        1,
        this.key(id),
        raw,
        serialize(next),
        this.ttl,
      );
      if (result === 1) return next;
      if (result === -1) return undefined;
    }
    throw new Error(`任务 ${id} 状态写入冲突过多，请稍后重试`);
  }

  private emit(event: string, task: Task): void {
    try {
      this.emitter.emit(event, task);
    } catch (err) {
      console.error(`[Task:${task.id}] 状态监听器出错: ${(err as Error).message}`);
    }
  }

  /**
   * 非终态更新。任务已经是终态时什么都不做：进度回调是异步发出的，可能晚于完成或取消到达，
   * 不能把已结束的任务改回处理中。返回更新后的任务，没有写入时返回 undefined
   */
  async update(id: string, updates: TaskUpdates): Promise<Task | undefined> {
    if (updates.status && isTerminal(updates.status)) {
      const { status, ...rest } = updates;
      return this.finish(id, { ...rest, status });
    }
    const next = await this.mutate(id, (task) => {
      if (isTerminal(task.status)) return undefined;
      if (updates.status === 'processing' && !task.startedAt) task.startedAt = new Date();
      return Object.assign(task, updates);
    });
    if (next) this.emit(`task:${id}`, next);
    return next;
  }

  /**
   * 原子地把任务推进到终态。已经是终态时不改动并返回 undefined：
   * 迟到的 completed 不会覆盖 cancelled，并发的两次终态写入只有一次生效（也只发一次 terminal 事件）
   */
  async finish(id: string, updates: TerminalUpdates): Promise<Task | undefined> {
    // 失败原因在写入前就去掉服务器目录：任务详情、SSE、回调都直接用这份记录
    const error =
      updates.error === undefined
        ? undefined
        : clientError({ id, status: updates.status }, updates.error);
    const next = await this.mutate(id, (task) => {
      if (isTerminal(task.status)) return undefined;
      const { progress, ...rest } = { ...updates, ...(error === undefined ? {} : { error }) };
      // 取消接口写终态时不知道 pipeline 跑到哪一步：正在执行的那一步跟着任务变成 cancelled / failed，
      // 和 CAS 在同一次写入里完成，不会和 Worker 的步骤更新交错
      const status = updates.status;
      if (!updates.steps && task.steps && status !== 'completed') {
        task.steps = task.steps.map((step) =>
          step.status === 'processing' ? { ...step, status } : step,
        );
      }
      Object.assign(task, rest);
      if (progress !== undefined) task.progress = progress;
      else if (updates.status === 'completed') task.progress = 100;
      task.completedAt = new Date();
      return task;
    });
    if (next) {
      this.emit(`task:${id}`, next);
      this.emit('terminal', next);
    }
    return next;
  }

  /** 记录回调投递结果。只对终态任务生效 */
  async recordCallback(id: string, callback: TaskCallback): Promise<Task | undefined> {
    return this.mutate(id, (task) => {
      if (!isTerminal(task.status)) return undefined;
      task.callback = callback;
      return task;
    });
  }

  /**
   * 进度这类丢一次也无妨的更新。失败只记日志：直接 void update() 的话，
   * Redis 一抖动就是未处理的 Promise 拒绝，Node 会把整个进程连同在跑的任务一起带崩。
   */
  updateQuietly(id: string, updates: TaskUpdates): void {
    this.update(id, updates).catch((err: Error) => this.warnQuietly(id, err));
  }

  warnQuietly(id: string, err: Error): void {
    const now = Date.now();
    if (now - this.lastQuietWarn < 10_000) return;
    this.lastQuietWarn = now;
    console.warn(`[Task:${id}] 任务状态写入 Redis 失败: ${err.message}`);
  }

  async ping(timeoutMs = 2000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.redis.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 发布一条 Redis 消息（取消广播用），返回收到的订阅者数 */
  publish(channel: string, message: string): Promise<number> {
    return this.redis.publish(channel, message);
  }

  /** 订阅单个任务的每次写入（SSE 用）。只能收到本进程内的写入 */
  onProgress(id: string, listener: (task: Task) => void): () => void {
    this.emitter.on(`task:${id}`, listener);
    return () => this.emitter.removeListener(`task:${id}`, listener);
  }

  /** 订阅所有任务进入终态的事件（回调分发用），每个任务只触发一次 */
  onTerminal(listener: (task: Task) => void): () => void {
    this.emitter.on('terminal', listener);
    return () => this.emitter.removeListener('terminal', listener);
  }

  /** 关闭自己建立的连接（测试和进程退出用）；外部传入的连接由调用方关闭 */
  async close(): Promise<void> {
    if (this.client && !this.opts.redis) await this.client.quit().catch(() => {});
    this.client = undefined;
  }
}

export const taskService = new TaskService();
