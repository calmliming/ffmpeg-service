import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import IORedis from 'ioredis';
import { TEST_REDIS_URL, cleanupRoot, redisAvailable } from './harness';
import { config } from '../../../src/config';
import { TaskService, taskView } from '../../../src/services/task.service';
import type { Task } from '../../../src/types';

let redisUp = false;
let redis: IORedis;
let tasks: TaskService;
const prefix = `ffsvc-test-${process.pid}-tasks:`;

before(async () => {
  redisUp = await redisAvailable();
  if (!redisUp) return;
  redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  tasks = new TaskService({ redis, keyPrefix: prefix, ttlSeconds: 120 });
});

after(async () => {
  if (redisUp) {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  }
  cleanupRoot();
});

function skipWithoutRedis(t: { skip(message?: string): void }): boolean {
  if (redisUp) return false;
  t.skip('Redis 不可用（localhost:6379）');
  return true;
}

test('终态之后：迟到的进度和 completed 都不会覆盖 cancelled', async (t) => {
  if (skipWithoutRedis(t)) return;
  const task = await tasks.create('trim', { callbackUrl: 'https://example.com/hook' });
  assert.equal(task.callbackUrl, 'https://example.com/hook');
  const started = await tasks.update(task.id, { status: 'processing', progress: 10 });
  assert.ok(started?.startedAt);

  const cancelled = await tasks.finish(task.id, { status: 'cancelled', error: '用户取消' });
  assert.equal(cancelled!.status, 'cancelled');
  assert.equal(cancelled!.progress, 10);
  assert.ok(cancelled!.completedAt);

  assert.equal(await tasks.update(task.id, { progress: 80, phase: 'merging' }), undefined);
  assert.equal(await tasks.update(task.id, { status: 'completed', progress: 100 }), undefined);
  assert.equal(await tasks.finish(task.id, { status: 'completed', outputs: [] }), undefined);
  const stored = await tasks.get(task.id);
  assert.equal(stored!.status, 'cancelled');
  assert.equal(stored!.progress, 10);
  assert.equal(stored!.phase, undefined);
  assert.equal(stored!.error, '用户取消');
});

test('并发的终态写入只有一个生效，terminal 事件只触发一次', async (t) => {
  if (skipWithoutRedis(t)) return;
  const task = await tasks.create('merge');
  await tasks.update(task.id, { status: 'processing' });
  const events: Task[] = [];
  const off = tasks.onTerminal((tk) => {
    if (tk.id === task.id) events.push(tk);
  });
  try {
    const statuses = ['completed', 'failed', 'cancelled'] as const;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        tasks.finish(task.id, { status: statuses[i % 3], error: `第 ${i} 个` }),
      ),
    );
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1);
    assert.equal(events.length, 1);
    const stored = await tasks.get(task.id);
    assert.equal(stored!.status, winners[0]!.status);
    assert.equal(stored!.error, winners[0]!.error);
  } finally {
    off();
  }
});

test('并发的进度写入和终态写入：终态之后的进度全部被丢弃', async (t) => {
  if (skipWithoutRedis(t)) return;
  const task = await tasks.create('compose');
  await tasks.update(task.id, { status: 'processing' });
  const writes: Promise<unknown>[] = [];
  for (let i = 1; i <= 30; i++) {
    writes.push(tasks.update(task.id, { progress: i }));
    if (i === 15) writes.push(tasks.finish(task.id, { status: 'completed', outputs: [] }));
  }
  await Promise.all(writes);
  const stored = await tasks.get(task.id);
  assert.equal(stored!.status, 'completed');
  assert.equal(stored!.progress, 100);
});

test('recordCallback 只对终态任务生效，日期能读回 Date', async (t) => {
  if (skipWithoutRedis(t)) return;
  const task = await tasks.create('gif', { callbackUrl: 'https://example.com/h' });
  assert.equal(await tasks.recordCallback(task.id, { delivered: false, attempts: 0 }), undefined);
  await tasks.finish(task.id, { status: 'failed', error: 'x' });
  const deliveredAt = new Date();
  await tasks.recordCallback(task.id, { delivered: true, attempts: 1, status: 200, deliveredAt });
  const stored = await tasks.get(task.id);
  assert.equal(stored!.callback!.deliveredAt!.getTime(), deliveredAt.getTime());
  assert.equal(stored!.status, 'failed');
  assert.equal(await tasks.recordCallback('missing', { delivered: true, attempts: 1 }), undefined);
});

test('SSE 订阅：每次写入都通知，终态也通知', async (t) => {
  if (skipWithoutRedis(t)) return;
  const task = await tasks.create('transcode');
  const seen: string[] = [];
  const off = tasks.onProgress(task.id, (tk) => seen.push(`${tk.status}:${tk.progress}`));
  await tasks.update(task.id, { status: 'processing', progress: 0 });
  await tasks.update(task.id, { progress: 40 });
  await tasks.finish(task.id, { status: 'completed' });
  await tasks.update(task.id, { progress: 50 });
  off();
  assert.deepEqual(seen, ['processing:0', 'processing:40', 'completed:100']);
});

test('taskView：去掉 inputFiles，算 elapsedSeconds，downloadUrl 来自 outputs，旧任务按 output 拼', () => {
  const startedAt = new Date('2026-10-27T00:00:00Z');
  const completedAt = new Date('2026-10-27T00:01:05Z');
  const legacy = {
    id: 'a',
    status: 'completed',
    progress: 100,
    type: 'transcode',
    createdAt: startedAt,
    startedAt,
    completedAt,
    output: '/app/output/x.mp4,/app/output/y.png',
    inputFiles: ['/app/uploads/secret.mp4'],
  } as Task;
  const view = taskView(legacy);
  assert.equal('inputFiles' in view, false);
  assert.equal(view.elapsedSeconds, 65);
  assert.deepEqual(view.downloadUrl, ['/api/files/x.mp4', '/api/files/y.png']);

  const modern: Task = {
    id: 'b',
    status: 'processing',
    progress: 30,
    type: 'hls',
    createdAt: startedAt,
    startedAt,
    outputs: [
      {
        name: 'd/index.m3u8',
        url: 'https://cdn/x/d/index.m3u8',
        size: 10,
        contentType: 'application/vnd.apple.mpegurl',
        storage: 's3',
        key: 'x/d/index.m3u8',
      },
    ],
  };
  const now = new Date('2026-10-27T00:00:10Z');
  const view2 = taskView(modern, now);
  assert.equal(view2.elapsedSeconds, 10);
  assert.deepEqual(view2.downloadUrl, ['https://cdn/x/d/index.m3u8']);

  const pending = taskView({ id: 'c', status: 'pending', progress: 0, type: 't', createdAt: now });
  assert.equal(pending.elapsedSeconds, undefined);
  assert.equal(pending.downloadUrl, undefined);
});

test('taskView：旧记录 output 里的绝对路径换成输出目录里的相对路径，不暴露服务器目录', () => {
  const createdAt = new Date('2026-10-27T00:00:00Z');
  const inside = path.join(config.outputDir, 'abc.mp4');
  const view = taskView({
    id: 'a',
    status: 'completed',
    progress: 100,
    type: 'watermark',
    createdAt,
    output: `${inside},D:\\Projects\\tools\\ffmpeg-service\\output\\x.mp4,/app/output/y.png`,
  });
  assert.equal(view.output, 'abc.mp4,x.mp4,y.png');
  assert.deepEqual(view.downloadUrl, [
    '/api/files/abc.mp4',
    '/api/files/x.mp4',
    '/api/files/y.png',
  ]);

  // 新记录本来就是相对路径（多文件产物带子目录），原样返回
  const modern = taskView({
    id: 'b',
    status: 'completed',
    progress: 100,
    type: 'hls',
    createdAt,
    output: 'd1/master.m3u8,d1/720p.m3u8',
  });
  assert.equal(modern.output, 'd1/master.m3u8,d1/720p.m3u8');
});

test('taskView：配置了 PUBLIC_BASE_URL 时本地产物的 downloadUrl 仍是相对路径，S3 地址原样', () => {
  const view = taskView({
    id: 'a',
    status: 'completed',
    progress: 100,
    type: 'extract-audio',
    createdAt: new Date(),
    outputs: [
      {
        name: 'a b#.mp3',
        url: 'https://media.example.com/api/files/a%20b%23.mp3',
        size: 1,
        contentType: 'audio/mpeg',
        storage: 'local',
      },
      {
        name: 'd/index.m3u8',
        url: 'https://cdn.example.com/p/d/index.m3u8?X-Amz-Signature=1',
        size: 1,
        contentType: 'application/vnd.apple.mpegurl',
        storage: 's3',
        key: 'p/d/index.m3u8',
      },
    ],
  });
  assert.deepEqual(view.downloadUrl, [
    '/api/files/a%20b%23.mp3',
    'https://cdn.example.com/p/d/index.m3u8?X-Amz-Signature=1',
  ]);
});

test('taskView / finish：失败原因去掉服务器目录（含旧记录），取消原因原样', async (t) => {
  // 任务工作目录（uploads/<taskId>）里的文件只留文件名，其他绝对路径也只留文件名
  const leakedFor = (id: string) =>
    `无法解析: ${path.join(config.uploadDir, id, 'input-0.txt')}: Invalid data（见 /api/info）| ` +
    `写入 ${path.join(config.outputDir, 'x.mp4')} 失败`;
  const clean = '无法解析: input-0.txt: Invalid data（见 /api/info）| 写入 x.mp4 失败';
  const view = taskView({
    id: 'a',
    status: 'failed',
    progress: 3,
    type: 'trim',
    createdAt: new Date(),
    error: leakedFor('a'),
  });
  assert.equal(view.error, clean);
  const reason = '用户取消：/mnt/share/a/b.mp4 选错了';
  const cancelled = taskView({
    id: 'b',
    status: 'cancelled',
    progress: 3,
    type: 'trim',
    createdAt: new Date(),
    error: reason,
  });
  assert.equal(cancelled.error, reason);

  if (skipWithoutRedis(t)) return;
  const task = await tasks.create('trim');
  const failed = await tasks.finish(task.id, { status: 'failed', error: leakedFor(task.id) });
  assert.equal(failed!.error, clean);
  assert.equal((await tasks.get(task.id))!.error, clean);
});
