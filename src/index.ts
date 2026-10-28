import './load-env'; // 必须是第一个 import，原因见 load-env.ts
import fs from 'fs';
import { version } from '../package.json';
import { createApp } from './app';
import { config } from './config';
import { MAX_PIPELINE_STEPS, PIPELINE_ROUTE } from './core/pipeline';
import { startWebhookDispatcher } from './core/webhook-dispatcher';
import { operations } from './operations';
import { createTaskWorker, getJobQueue } from './services/queue.service';
import {
  closeStorage,
  getS3Client,
  startOutputRetentionSweeper,
  storageDriver,
} from './services/storage.service';
import { taskService } from './services/task.service';

// multer 的磁盘存储不会自己建目录，全新部署（或挂载了空卷）时第一个上传就会 ENOENT
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });

// S3 配置写错（AWS 没设区域、endpoint 不是 http(s)、密钥只填了一半）时启动就失败，
// 而不是等第一个任务跑完上传时才报错、白跑一遍
if (config.s3.bucket) {
  try {
    getS3Client();
  } catch (err) {
    console.error(`对象存储配置错误: ${(err as Error).message}`);
    process.exit(1);
  }
}

const queue = getJobQueue();
const worker = createTaskWorker({ operations, tasks: taskService }); // 启动 BullMQ Worker
const webhooks = startWebhookDispatcher(taskService);
const stopSweeper = startOutputRetentionSweeper();
const app = createApp({ operations, tasks: taskService, queue });

function printSummary() {
  console.log(`FFmpeg Service v${version} 已启动: http://localhost:${config.port}`);
  console.log(
    `并发 ${config.maxConcurrentTasks} | 存储 ${storageDriver()} | 队列上限 ${config.maxQueueLength || '不限'} | 鉴权 ${config.apiKeys.length ? `已开启（${config.apiKeys.length} 个 Key）` : '未开启'}`,
  );
  if (!config.apiKeys.length) {
    console.warn('[警告] 未配置 API_KEYS，所有接口无需鉴权即可调用。对公网开放前务必设置');
  }
  const width = Math.max(28, ...operations.map((op) => op.route.length + 2));
  const line = (method: string, route: string, title: string) =>
    console.log(`  ${method.padEnd(4)} ${route.padEnd(width)} ${title}`);
  console.log(`接口（${operations.length} 个操作）:`);
  line('GET', '/api/health', '健康检查');
  line('GET', '/api/operations', '操作列表与参数说明');
  line('GET', '/api/openapi.json', 'OpenAPI 3.1 文档');
  for (const op of operations) line('POST', op.route, op.sync ? `${op.title}（同步）` : op.title);
  line('POST', PIPELINE_ROUTE, `多步骤处理（最多 ${MAX_PIPELINE_STEPS} 步）`);
  line('GET', '/api/tasks/:id', '查询任务状态');
  line('GET', '/api/tasks/:id/progress', 'SSE 实时进度');
  line('POST', '/api/tasks/:id/cancel', '取消任务（同 DELETE /api/tasks/:id）');
  line('GET', '/api/files/*', '下载产物');
}

const server = app.listen(config.port, (err?: Error) => {
  // Express 5 把监听错误交给回调，不处理的话端口被占用时会打印「已启动」却从未监听（Express 4 会直接崩溃退出）
  if (err) {
    console.error(`端口 ${config.port} 监听失败: ${err.message}`);
    process.exit(1);
  }
  printSummary();
});

// 优雅关闭：等待当前 ffmpeg 任务完成后再退出
async function shutdown(signal: string) {
  console.log(`\n收到 ${signal} 信号，等待当前任务完成后关闭...`);
  server.close();
  stopSweeper();
  // 强制超时兜底（与 docker stop_grace_period 对齐）
  const forceExit = setTimeout(() => {
    console.error('关闭超时，强制退出');
    process.exit(1);
  }, 600000).unref();
  // Redis 不可用时 worker.close() 不会返回（BullMQ 各版本都如此，6.x 在启动后从未连上时也会挂住），
  // 只能干等 600 s。任务状态本来也写不进去，直接退出
  if (!(await taskService.ping())) {
    console.error('Redis 不可用，无法等待任务正常结束，直接退出');
    process.exit(1);
  }
  await worker.close();
  // 最后几个任务的回调还在投递，等一会儿再走（超时就放弃）
  webhooks.stop();
  await webhooks.drain(15_000);
  closeStorage();
  clearTimeout(forceExit);
  console.log('服务已安全关闭');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
