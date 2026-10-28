import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import IORedis from 'ioredis';
import { config } from '../../../src/config';
import { createApp } from '../../../src/app';
import { cancelChannel } from '../../../src/core/cancel';
import {
  startWebhookDispatcher,
  type DeliverWebhook,
  type WebhookDispatcher,
} from '../../../src/core/webhook-dispatcher';
import type { AnyOperation } from '../../../src/operations/types';
import {
  createJobQueue,
  createTaskWorker,
  type JobQueue,
  type StoreOutputs,
  type TaskWorker,
} from '../../../src/services/queue.service';
import { TaskService } from '../../../src/services/task.service';
import type { Task, TaskStatus } from '../../../src/types';

// 引擎测试连真实的 Redis（容器 ffmpeg-svc-redis），用单独的库和前缀，结束时只删自己的 key，不 FLUSHDB：
// node --test 会并行跑多个测试文件，它们共用这个库
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsvc-engine-'));
export const uploadDir = path.join(root, 'uploads');
export const outputDir = path.join(root, 'output');
fs.mkdirSync(uploadDir);
fs.mkdirSync(outputDir);

config.redisUrl = TEST_REDIS_URL;
config.uploadDir = uploadDir;
config.outputDir = outputDir;
config.allowPrivateUrls = true;
config.apiKeys = [];
config.protectFiles = false;
config.saveOutputFile = true;
config.publicBaseUrl = '';
config.maxQueueLength = 0;
config.s3.bucket = '';
config.downloadRetries = 0;
config.downloadIdleTimeoutMs = 5000;

export async function redisAvailable(): Promise<boolean> {
  const client = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

let engineCount = 0;

export interface EngineOptions {
  operations: AnyOperation[];
  /** 默认 true；false 时只有队列没有 Worker，job 会一直排着（测试队列已满） */
  worker?: boolean;
  deliverWebhook?: DeliverWebhook;
  storeOutputs?: StoreOutputs;
  auth?: RequestHandler;
  /** Worker 定时查任务状态的间隔，默认 5 秒 */
  cancelPollMs?: number;
}

export interface Engine {
  base: string;
  /** BullMQ key 前缀，另起 Worker（模拟另一个实例）时用 */
  prefix: string;
  tasks: TaskService;
  queue: JobQueue;
  worker?: TaskWorker;
  dispatcher: WebhookDispatcher;
  close(): Promise<void>;
}

/** 等 Worker 订阅上取消频道：subscribe 是异步的，太早广播的取消没人收到 */
async function waitForCancelSubscribers(redis: IORedis, channel: string, count = 1): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [, subscribers] = (await redis.pubsub('NUMSUB', channel)) as [string, number];
    if (Number(subscribers) >= count) return;
    if (Date.now() > deadline) throw new Error(`取消频道 ${channel} 没有订阅者`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export interface ExtraWorker {
  worker: TaskWorker;
  close(): Promise<void>;
}

/** 在已有引擎的队列上另起一个 Worker（独立连接），模拟多实例部署里执行任务的另一台机器 */
export async function startWorker(
  engine: Engine,
  operations: AnyOperation[],
  opts: { cancelPollMs?: number } = {},
): Promise<ExtraWorker> {
  const connection = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  const worker = createTaskWorker({
    operations,
    tasks: engine.tasks,
    connection,
    prefix: engine.prefix,
    concurrency: 2,
    ...(opts.cancelPollMs ? { cancelPollMs: opts.cancelPollMs } : {}),
  });
  await worker.waitUntilReady();
  const probe = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  try {
    await waitForCancelSubscribers(probe, cancelChannel(worker.qualifiedName));
  } finally {
    probe.disconnect();
  }
  return {
    worker,
    async close() {
      await worker.close();
      connection.disconnect();
    },
  };
}

/** 起一个完整的引擎：独立 BullMQ 前缀和任务 key 前缀的队列、Worker、回调分发和 HTTP 服务 */
export async function startEngine(opts: EngineOptions): Promise<Engine> {
  const prefix = `ffsvc-test-${process.pid}-${++engineCount}`;
  const redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  const workerRedis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  const tasks = new TaskService({ redis, keyPrefix: `${prefix}:task:` });
  const queue = createJobQueue({ connection: redis, prefix });
  const worker =
    opts.worker === false
      ? undefined
      : createTaskWorker({
          operations: opts.operations,
          tasks,
          connection: workerRedis,
          prefix,
          concurrency: 4,
          storeOutputs: opts.storeOutputs,
          ...(opts.cancelPollMs ? { cancelPollMs: opts.cancelPollMs } : {}),
        });
  const dispatcher = startWebhookDispatcher(
    tasks,
    opts.deliverWebhook ?? (async () => ({ delivered: true, attempts: 1, status: 200 })),
  );
  const app = createApp({ operations: opts.operations, tasks, queue, auth: opts.auth });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  if (worker) {
    await worker.waitUntilReady();
    await waitForCancelSubscribers(redis, cancelChannel(worker.qualifiedName));
  }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    prefix,
    tasks,
    queue,
    worker,
    dispatcher,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await worker?.close();
      dispatcher.stop();
      await dispatcher.drain(2000);
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
      redis.disconnect();
      workerRedis.disconnect();
    },
  };
}

/** 轮询任务直到进入终态（或指定状态） */
export async function waitForTask(
  tasks: TaskService,
  id: string,
  until: (task: Task) => boolean = (t) => ['completed', 'failed', 'cancelled'].includes(t.status),
  timeoutMs = 15_000,
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await tasks.get(id);
    if (task && until(task)) return task;
    if (Date.now() > deadline) {
      throw new Error(`等待任务 ${id} 超时，当前状态 ${task?.status ?? '不存在'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const hasStatus = (status: TaskStatus) => (task: Task) => task.status === status;

export interface JsonResponse {
  status: number;
  body: { success: boolean; data?: Record<string, unknown>; error?: string } & Record<
    string,
    unknown
  >;
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as JsonResponse['body'] };
}

export async function postForm(url: string, form: FormData): Promise<JsonResponse> {
  const res = await fetch(url, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as JsonResponse['body'] };
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: (await res.json()) as JsonResponse['body'] };
}

export async function sendJson(method: string, url: string, body?: unknown): Promise<JsonResponse> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as JsonResponse['body'] };
}

/** 一直等到条件成立 */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** multipart 里的一个文件 */
export function fileBlob(content: string | Buffer, type = 'application/octet-stream'): Blob {
  return new Blob([typeof content === 'string' ? content : new Uint8Array(content)], { type });
}

/** 等 multer 落盘文件的异步删除完成 */
export async function waitForEmptyDir(dir: string, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0 || Date.now() > deadline) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 本地 HTTP 文件服务器，模拟 URL 输入 */
export async function startFileServer(
  files: Record<string, Buffer>,
): Promise<{ base: string; hits: Map<string, number>; close(): Promise<void> }> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    const body = files[pathname];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length, 'content-type': 'video/mp4' });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function cleanupRoot(): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** 输出目录里现存的文件（递归，相对路径） */
export function listOutputs(): string[] {
  return (fs.readdirSync(outputDir, { recursive: true }) as string[])
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => fs.statSync(path.join(outputDir, p)).isFile());
}
