// crash.test.ts 起的子进程：一个只跑 test-crash 的 Worker。操作写下一部分产物、汇报进度后一直挂着，
// 由测试直接杀掉进程，模拟执行中途崩溃、OOM 或被 kill
import fs from 'node:fs';
import path from 'node:path';
import IORedis from 'ioredis';
import { z } from 'zod';
import { config } from '../../../src/config';
import { defineOperation } from '../../../src/operations/types';
import { createTaskWorker } from '../../../src/services/queue.service';
import { TaskService } from '../../../src/services/task.service';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

config.uploadDir = env('CRASH_UPLOAD_DIR');
config.outputDir = env('CRASH_OUTPUT_DIR');
config.redisUrl = env('CRASH_REDIS_URL');
const prefix = env('CRASH_PREFIX');

const hangOp = defineOperation({
  name: 'test-crash',
  route: '/api/test/crash',
  title: '测试崩溃',
  description: '写一部分产物后挂起，等着被杀',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    const file = ctx.outputPath('mp4');
    await fs.promises.writeFile(file, 'partial');
    const dir = await ctx.outputDir();
    await fs.promises.writeFile(path.join(dir, 'seg0.ts'), 'partial');
    ctx.progress(0.4);
    process.stdout.write(`READY ${JSON.stringify({ file, dir, workDir: ctx.workDir })}\n`);
    return new Promise<never>(() => {});
  },
});

const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: 2 });
const tasks = new TaskService({ redis, keyPrefix: `${prefix}:task:` });
createTaskWorker({
  operations: [hangOp],
  tasks,
  connection: new IORedis(config.redisUrl, { maxRetriesPerRequest: null }),
  prefix,
  concurrency: 1,
  // 锁 1 秒：进程被杀后很快过期，另一个 Worker 的卡死检测才能尽快把 job 放回队列。
  // 卡死检测的间隔也要短：BullMQ 用一个按间隔过期的共享 key 限制检测频率，这里设了 30 秒的话别的 Worker 也要等 30 秒
  stalled: { lockDuration: 1000, stalledInterval: 300 },
});
