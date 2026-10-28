import express, { type Express, type RequestHandler } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { describeOperation } from './core/catalog';
import { COMMON_FIELDS, urlFieldsOf } from './core/inputs';
import { PIPELINE_OP } from './core/pipeline';
import { redactApiKey, requireApiKey, requireApiKeyForFiles } from './middleware/auth';
import { errorHandler } from './middleware/error';
import { removeUploadedFiles } from './middleware/upload';
import { operations as registryOperations } from './operations';
import type { AnyOperation } from './operations/types';
import { createFilesRouter } from './routes/files';
import { createHealthRouter, type StorageHealth } from './routes/health';
import { createOpenApiRouter } from './routes/openapi';
import { createCatalogRouter, createOperationRouter, type SyncLimits } from './routes/operations';
import { createPipelineRouter } from './routes/pipeline';
import { createTaskRouter } from './routes/tasks';
import { config } from './config';
import { getJobQueue, type CancelQueue, type JobQueue } from './services/queue.service';
import { taskService, type TaskService } from './services/task.service';

/** HTTP 层用到的队列能力：入队、计数，取消时查 job、删 job 和广播 */
export type AppQueue = Pick<JobQueue, 'add' | 'getJobCounts'> & CancelQueue;

export interface AppOptions {
  /** 默认是 src/operations 注册表里的全部操作 */
  operations?: readonly AnyOperation[];
  tasks?: TaskService;
  queue?: AppQueue;
  /** 默认 requireApiKey，测试可以替换 */
  auth?: RequestHandler;
  /** HTTP 请求里队列操作（入队、查队列长度、取消）的超时，默认 QUEUE_COMMAND_TIMEOUT_MS */
  queueTimeoutMs?: number;
  /** 同步接口的并发和排队上限，默认按 CPU 数计算 */
  syncLimits?: SyncLimits;
  /** 健康检查执行 ffmpeg / ffprobe -version 的方式，测试可以替换 */
  checkBinary?: (file: string) => Promise<boolean>;
  /** 健康检查检查存储（目录可写、S3 存储桶）的方式，测试可以替换 */
  checkStorage?: () => Promise<StorageHealth>;
}

/** 引擎自己的路由，操作不能占用 */
const RESERVED_ROUTE = /^\/api\/(health|tasks|files|operations|openapi|pipelines?)(\/|$)/i;

/** 注册表之外（测试注入）的操作也要过一遍，路由冲突或字段重名会让请求静默地走错分支 */
function assertOperations(operations: readonly AnyOperation[]): void {
  const names = new Set<string>();
  const routes = new Set<string>();
  for (const op of operations) {
    const where = `操作 ${op.name}`;
    if (names.has(op.name)) throw new Error(`操作名称重复: ${op.name}`);
    // pipeline 任务的 type 和 job 名就是 pipeline，同名操作的 job 会被当成 pipeline 执行
    if (op.name === PIPELINE_OP) throw new Error(`操作名 ${PIPELINE_OP} 是内置的，不能使用`);
    // chainable 的操作会被 pipeline 拿上一步的产物当 file 输入，必须真有这样的槽
    const file = op.inputs.find((slot) => slot.name === 'file');
    if (op.chainable && (op.sync || !file || file.multiple)) {
      throw new Error(`${where} 标记了 chainable，但不是带单文件 file 输入槽的异步操作`);
    }
    if (routes.has(op.route.toLowerCase())) throw new Error(`操作路由重复: ${op.route}`);
    names.add(op.name);
    routes.add(op.route.toLowerCase());
    // 鉴权挂在 /api 上，路由不在 /api 下就绕过了鉴权
    if (!/^\/api\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(op.route)) {
      throw new Error(`${where} 的路由必须是 /api/ 下的固定路径: ${op.route}`);
    }
    if (RESERVED_ROUTE.test(op.route)) throw new Error(`${where} 占用了内置路由: ${op.route}`);

    const paramKeys = new Set(Object.keys(op.params.shape));
    const fields = new Set<string>(COMMON_FIELDS);
    for (const key of COMMON_FIELDS) {
      if (paramKeys.has(key)) throw new Error(`${where} 的参数 ${key} 与通用字段重名`);
    }
    const slots = new Set<string>();
    for (const slot of op.inputs) {
      if (slots.has(slot.name)) throw new Error(`${where} 的输入槽重名: ${slot.name}`);
      slots.add(slot.name);
      if (slot.multiple && (slot.multiple.min < 0 || slot.multiple.max < slot.multiple.min)) {
        throw new Error(`${where} 的输入槽 ${slot.name} 数量范围不合法`);
      }
      for (const field of urlFieldsOf(slot)) {
        if (fields.has(field)) throw new Error(`${where} 的链接字段重名: ${field}`);
        if (paramKeys.has(field)) throw new Error(`${where} 的参数 ${field} 与链接字段重名`);
        fields.add(field);
      }
    }
  }
}

/** 组装 Express 应用（不监听端口）。Worker、队列、回调分发由 src/index.ts 启动 */
export function createApp(options: AppOptions = {}): Express {
  const operations = options.operations ?? registryOperations;
  const tasks = options.tasks ?? taskService;
  const queue = options.queue ?? getJobQueue();
  const auth = options.auth ?? requireApiKey;
  // 注入的 auth（测试）对下载的作用方式和默认的 requireApiKeyForFiles 一致：只在 PROTECT_FILES=true 时鉴权
  const injected = options.auth;
  const filesAuth: RequestHandler = injected
    ? (req, res, next) => (config.protectFiles ? injected(req, res, next) : next())
    : requireApiKeyForFiles;
  assertOperations(operations);
  // 操作的参数 schema 没写自定义信息时，zod 的默认提示也用中文
  z.config(z.locales.zhCN());

  const app = express();

  app.use(cors());
  // Express 5 的 body-parser 2 会解 br / zstd 请求体（Express 4 直接返回 415），而 Node 24.22.0、26.12.0 及更早版本的
  // Brotli 解码器有越界写（CVE-2026-111497）。只放行 Express 4 时就支持的编码
  app.use((req, res, next) => {
    const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding === 'identity' || encoding === 'gzip' || encoding === 'deflate') return next();
    res.status(415).json({ success: false, error: `不支持的 Content-Encoding: ${encoding}` });
  });

  // 请求日志。SSE（EventSource 不能带请求头）会把 Key 放在 ?api_key= 里，写日志前打码
  app.use((req, res, next) => {
    const start = Date.now();
    const log = (status: string) => {
      const ms = Date.now() - start;
      const url = redactApiKey(req.originalUrl);
      console.log(`[${new Date().toISOString()}] ${req.method} ${url} ${status} ${ms}ms`);
    };
    res.on('finish', () => log(String(res.statusCode)));
    // 客户端在响应发完之前断开（上传途中超时、Ctrl+C、关掉 SSE）不会有 finish，按 499 记一笔
    res.on('close', () => {
      if (!res.writableFinished) log('499（客户端已断开）');
    });
    next();
  });

  // 鉴权放在解析请求体之前，未授权的请求不会让服务器解析 JSON 或把上传写到磁盘。
  // 健康检查给负载均衡探活用，不鉴权；/api/files 的文件名是随机 UUID，默认不鉴权（PROTECT_FILES=true 时鉴权）。
  // Express 的路由不区分大小写，这里同样按小写比较，/API/Files 不会绕过下载的规则
  app.use('/api', (req, res, next) => {
    const p = req.path.toLowerCase().replace(/\/+$/, '');
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/health') return next();
    if (p === '/files' || p.startsWith('/files/')) return filesAuth(req, res, next);
    auth(req, res, next);
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 上传成功但请求被拒绝（缺参数、入队失败）或客户端中途断开时，multer 已经落盘的文件没有任务会去清理。
  // 入队成功（文件交给 Worker）和同步接口（自己清理）会设置 keepUploads。
  // 中途断开时还有写到一半的文件，removeUploadedFiles 一并删除；它不会抛错（这里抛错会带崩整个进程）
  app.use((req, res, next) => {
    res.on('close', () => {
      if (!res.locals.keepUploads) removeUploadedFiles(req);
    });
    next();
  });

  // 静态文件服务 - 输出文件下载
  app.use('/api/files', createFilesRouter());

  // 操作目录和 OpenAPI 文档共用，参数的 JSON Schema 只在启动时算一次
  const catalog = operations.map(describeOperation);
  app.use(
    '/api/health',
    createHealthRouter({
      ping: () => tasks.ping(),
      operationCount: operations.length,
      jobCounts: () => queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed'),
      ...(options.checkBinary ? { checkBinary: options.checkBinary } : {}),
      ...(options.checkStorage ? { checkStorage: options.checkStorage } : {}),
    }),
  );
  const { queueTimeoutMs, syncLimits } = options;
  app.use('/api/operations', createCatalogRouter(catalog));
  app.use('/api/openapi.json', createOpenApiRouter(catalog));
  app.use('/api/tasks', createTaskRouter(tasks, { queue, queueTimeoutMs }));
  app.use(createPipelineRouter(operations, { tasks, queue, queueTimeoutMs }));
  app.use(createOperationRouter(operations, { tasks, queue, queueTimeoutMs, syncLimits }));

  app.use('/api', (req, res) => {
    // 只回显路径，不带查询串（里面可能有 api_key）
    const route = `${req.baseUrl}${req.path}`;
    res.status(404).json({ success: false, error: `接口不存在: ${req.method} ${route}` });
  });

  // 错误处理
  app.use(errorHandler);
  return app;
}
