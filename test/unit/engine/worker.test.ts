import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  cleanupRoot,
  fileBlob,
  getJson,
  hasStatus,
  listOutputs,
  outputDir,
  postForm,
  postJson,
  redisAvailable,
  startEngine,
  startFileServer,
  uploadDir,
  waitForEmptyDir,
  waitForTask,
  type Engine,
} from './harness';
import { config } from '../../../src/config';
import { allOps, allocatedBy } from './fake-ops';
import { ffmpegSkip, makeTempDir, makeVideo } from '../../helpers/media';
import type { DeliverWebhook } from '../../../src/core/webhook-dispatcher';
import { defineOperation } from '../../../src/operations/types';
import { probeMedia } from '../../../src/utils/media-probe';
import type { Task } from '../../../src/types';

const CLIP = Buffer.alloc(2048, 5);
let redisUp = false;
let engine: Engine;
let files: Awaited<ReturnType<typeof startFileServer>>;

type WebhookCall = {
  url: string;
  payload: { event: string; task: Record<string, unknown> };
  event: string;
};
const webhookCalls: WebhookCall[] = [];
let webhookResult = { delivered: true, attempts: 1, status: 200 } as Awaited<
  ReturnType<DeliverWebhook>
>;
const deliverSpy: DeliverWebhook = async (url, payload, opts) => {
  webhookCalls.push({
    url,
    payload: payload as WebhookCall['payload'],
    event: opts?.event ?? '',
  });
  return webhookResult;
};

// 真实 ffmpeg：缩放成 160x120，验证 ctx.ffmpeg 的进度和产物在引擎里走通
const scaleOp = defineOperation({
  name: 'test-scale',
  route: '/api/test/scale',
  title: '测试缩放',
  description: '用 ffmpeg 缩小视频',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '视频' }],
  params: z.object({}),
  async run(ctx) {
    const input = ctx.inputs.file[0];
    const media = await ctx.probe(input);
    const out = ctx.outputPath('mp4');
    await ctx.ffmpeg(
      ['-i', input, '-vf', 'scale=160:120', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', out],
      { duration: media.duration },
    );
    return { files: [out], data: { duration: media.duration } };
  },
});

// 报错信息里带服务器上的绝对路径（ffmpeg / ffprobe / 文件系统的报错都是这样），还提到一个接口路径
const leakOp = defineOperation({
  name: 'test-leak',
  route: '/api/test/leak',
  title: '测试路径泄露',
  description: '失败信息里带输入文件和工作目录的绝对路径',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    const file = ctx.inputs.file[0];
    throw new Error(
      `无法解析输入文件: ${file}: Invalid data | ENOENT: open '${ctx.tempPath('list.txt')}'（纯音频请用 /api/audio/normalize）`,
    );
  },
});

before(async () => {
  redisUp = await redisAvailable();
  files = await startFileServer({ '/a.mp4': CLIP, '/b.mp4': CLIP, '/music.mp3': CLIP });
  if (redisUp) {
    engine = await startEngine({
      operations: [...allOps, scaleOp, leakOp],
      deliverWebhook: deliverSpy,
    });
  }
});

after(async () => {
  await engine?.close();
  await files.close();
  cleanupRoot();
});

function skipWithoutRedis(t: { skip(message?: string): void }): boolean {
  if (redisUp) return false;
  t.skip('Redis 不可用（localhost:6379）');
  return true;
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('操作失败：任务 failed 带原因，已分配的产物（文件和目录）被删除', async (t) => {
  if (skipWithoutRedis(t)) return;
  const res = await postJson(`${engine.base}/api/test/fail`, { url: `${files.base}/a.mp4` });
  const taskId = res.body.data!.taskId as string;
  const task = await waitForTask(engine.tasks, taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, '故意失败');
  assert.equal(task.outputs, undefined);
  const allocated = allocatedBy.get(taskId)!;
  assert.equal(allocated.length, 2);
  for (const p of allocated) assert.equal(fs.existsSync(p), false, `${p} 应已删除`);
  assert.equal(fs.existsSync(path.join(uploadDir, taskId)), false);
});

test('取消：worker.cancelJob 中止执行，任务 cancelled，产物删除，迟到的写入不覆盖', async (t) => {
  if (skipWithoutRedis(t)) return;
  const form = new FormData();
  form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  const res = await postForm(`${engine.base}/api/test/wait`, form);
  const taskId = res.body.data!.taskId as string;
  // 上传输入没有下载阶段，操作的 0.5 对应总进度 0.5 × 0.97 = 48%
  await waitForTask(engine.tasks, taskId, (task) => task.progress === 48);
  assert.equal(engine.worker!.cancelJob(taskId, '用户取消'), true);
  const task = await waitForTask(engine.tasks, taskId);
  assert.equal(task.status, 'cancelled');
  assert.equal(task.error, '用户取消');
  assert.ok(task.completedAt);
  for (const p of allocatedBy.get(taskId)!) assert.equal(fs.existsSync(p), false);
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);

  await engine.tasks.update(taskId, { progress: 99, status: 'processing' });
  assert.equal(await engine.tasks.finish(taskId, { status: 'completed' }), undefined);
  const after = await engine.tasks.get(taskId);
  assert.equal(after!.status, 'cancelled');
  assert.equal(after!.progress, task.progress);

  // 不加 reason 取消时给出默认原因
  const second = await postJson(`${engine.base}/api/test/wait`, { url: `${files.base}/a.mp4` });
  const secondId = second.body.data!.taskId as string;
  await waitForTask(engine.tasks, secondId, (t2) => t2.progress >= 50);
  engine.worker!.cancelJob(secondId);
  const cancelled = await waitForTask(engine.tasks, secondId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error, '任务已取消');
});

test('排队期间已取消的任务不再执行，上传文件被删除', async (t) => {
  if (skipWithoutRedis(t)) return;
  const idle = await startEngine({ operations: allOps, worker: false });
  try {
    const form = new FormData();
    form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
    const res = await postForm(`${idle.base}/api/test/copy`, form);
    const taskId = res.body.data!.taskId as string;
    // 用 engine 的 Worker 处理不了 idle 的队列，这里直接把任务改成 cancelled，再起一个 Worker 消费
    await idle.tasks.finish(taskId, { status: 'cancelled', error: '用户取消' });
    const { createTaskWorker } = await import('../../../src/services/queue.service');
    const IORedis = (await import('ioredis')).default;
    const connection = new IORedis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15', {
      maxRetriesPerRequest: null,
    });
    const job = await idle.queue.getJob(taskId);
    const worker = createTaskWorker({
      operations: allOps,
      tasks: idle.tasks,
      connection,
      prefix: (job as unknown as { queue: { opts: { prefix: string } } }).queue.opts.prefix,
    });
    try {
      await waitFor(() => fs.readdirSync(uploadDir).length === 0);
      const task = await idle.tasks.get(taskId);
      assert.equal(task!.status, 'cancelled');
      assert.equal(task!.outputs, undefined);
    } finally {
      await worker.close();
      connection.disconnect();
    }
  } finally {
    await idle.close();
  }
});

test('回调：终态时以任务详情调用 deliverWebhook，结果记录到 task.callback', async (t) => {
  if (skipWithoutRedis(t)) return;
  webhookCalls.length = 0;
  webhookResult = { delivered: true, attempts: 2, status: 204, deliveryId: 'delivery-1' };
  const ok = await postJson(`${engine.base}/api/test/copy`, {
    url: `${files.base}/a.mp4`,
    callbackUrl: 'http://127.0.0.1:9/hook',
  });
  const okId = ok.body.data!.taskId as string;
  const done = await waitForTask(engine.tasks, okId, (task) => Boolean(task.callback));
  assert.equal(done.status, 'completed');
  assert.equal(done.callback!.delivered, true);
  assert.equal(done.callback!.attempts, 2);
  assert.equal(done.callback!.status, 204);
  assert.equal(done.callback!.deliveryId, 'delivery-1');
  assert.ok(done.callback!.deliveredAt instanceof Date);

  const call = webhookCalls.find((c) => c.payload.task.id === okId)!;
  assert.equal(call.url, 'http://127.0.0.1:9/hook');
  assert.equal(call.event, 'task.completed');
  assert.equal(call.payload.event, 'task.completed');
  assert.equal(call.payload.task.status, 'completed');
  assert.deepEqual(
    call.payload.task.downloadUrl,
    done.outputs!.map((o) => o.url),
  );
  assert.equal('inputFiles' in call.payload.task, false);

  webhookResult = { delivered: false, attempts: 4, status: 500, error: 'HTTP 500' };
  const bad = await postJson(`${engine.base}/api/test/fail`, {
    url: `${files.base}/a.mp4`,
    callbackUrl: 'http://127.0.0.1:9/hook',
  });
  const badId = bad.body.data!.taskId as string;
  const failed = await waitForTask(engine.tasks, badId, (task) => Boolean(task.callback));
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.callback, {
    delivered: false,
    attempts: 4,
    status: 500,
    error: 'HTTP 500',
  });
  assert.equal(webhookCalls.find((c) => c.payload.task.id === badId)!.event, 'task.failed');

  // 没有 callbackUrl 的任务不投递
  const before = webhookCalls.length;
  const silent = await postJson(`${engine.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
  await waitForTask(engine.tasks, silent.body.data!.taskId as string);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(webhookCalls.length, before);
  webhookResult = { delivered: true, attempts: 1, status: 200 };
});

test('回调：取消也会投递 task.cancelled，且不占用 Worker（投递慢也不阻塞下一个任务）', async (t) => {
  if (skipWithoutRedis(t)) return;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slowCalls: string[] = [];
  const slow = await startEngine({
    operations: allOps,
    deliverWebhook: async (_url, payload, opts) => {
      slowCalls.push(opts?.event ?? '');
      void payload;
      await gate;
      return { delivered: true, attempts: 1, status: 200 };
    },
  });
  try {
    const res = await postJson(`${slow.base}/api/test/wait`, {
      url: `${files.base}/a.mp4`,
      callbackUrl: 'http://127.0.0.1:9/hook',
    });
    const taskId = res.body.data!.taskId as string;
    await waitForTask(slow.tasks, taskId, (task) => task.progress >= 50);
    slow.worker!.cancelJob(taskId);
    await waitForTask(slow.tasks, taskId, hasStatus('cancelled'));
    await waitFor(() => slowCalls.length === 1);
    assert.equal(slowCalls[0], 'task.cancelled');
    assert.equal(slow.dispatcher.pending, 1);

    // 回调还卡着，后面的任务照样完成
    const next = await postJson(`${slow.base}/api/test/copy`, { url: `${files.base}/b.mp4` });
    const nextTask = await waitForTask(slow.tasks, next.body.data!.taskId as string);
    assert.equal(nextTask.status, 'completed');

    release();
    const recorded = await waitForTask(slow.tasks, taskId, (task) => Boolean(task.callback));
    assert.equal(recorded.callback!.delivered, true);
  } finally {
    release();
    await slow.close();
  }
});

test('升级前留在 Redis 里的 job：按操作名映射成新格式执行，未知类型明确失败', async (t) => {
  if (skipWithoutRedis(t)) return;
  const upload = path.join(uploadDir, 'legacy-input.mp4');
  const image = path.join(uploadDir, 'legacy-image.png');
  fs.writeFileSync(upload, CLIP);
  fs.writeFileSync(image, 'png');
  const task = await engine.tasks.create('test-legacy-gif');
  await engine.queue.add('test-legacy-gif', {
    taskId: task.id,
    type: 'test-legacy-gif',
    inputPath: upload,
    options: { width: '480', image },
    format: 'webp',
  } as never);
  const done = await waitForTask(engine.tasks, task.id);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(done.result, { width: 480, hasImage: true });
  assert.match(done.outputs![0].name, /\.webp$/);
  assert.equal(fs.existsSync(upload), false);
  assert.equal(fs.existsSync(image), false);

  // 旧 compose：videos / music 是链接
  const compose = await engine.tasks.create('test-legacy-compose');
  await engine.queue.add('test-legacy-compose', {
    taskId: compose.id,
    type: 'test-legacy-compose',
    options: {
      videos: [`${files.base}/a.mp4`, `${files.base}/b.mp4`],
      music: `${files.base}/music.mp3`,
      musicVolume: 0.5,
      muteOriginalAudio: false,
    },
  } as never);
  const composed = await waitForTask(engine.tasks, compose.id);
  assert.equal(composed.status, 'completed', composed.error);
  assert.deepEqual(composed.result, { videos: 2, music: true, volume: 0.5 });

  const unknown = await engine.tasks.create('thumbnail');
  const orphan = path.join(uploadDir, 'orphan.mp4');
  fs.writeFileSync(orphan, CLIP);
  await engine.queue.add('thumbnail', {
    taskId: unknown.id,
    type: 'thumbnail',
    inputPath: orphan,
    options: { count: 3 },
  } as never);
  const failed = await waitForTask(engine.tasks, unknown.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '升级前提交的 thumbnail 任务在新版服务中没有对应的操作，请重新提交');
  await waitFor(() => !fs.existsSync(orphan));

  const badParams = await engine.tasks.create('test-legacy-gif');
  const input2 = path.join(uploadDir, 'legacy-2.mp4');
  fs.writeFileSync(input2, CLIP);
  await engine.queue.add('test-legacy-gif', {
    taskId: badParams.id,
    type: 'test-legacy-gif',
    inputPath: input2,
    options: { width: 5 },
  } as never);
  const rejected = await waitForTask(engine.tasks, badParams.id);
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error!, /参数与新版接口不兼容（width 必须是 16 到 1920 之间的整数）/);
});

test('伪造的 job：输入路径不在上传目录、产物不在输出目录都会失败，且不会删除目录外的文件', async (t) => {
  if (skipWithoutRedis(t)) return;
  const outside = path.join(path.dirname(uploadDir), 'outside.mp4');
  fs.writeFileSync(outside, CLIP);
  try {
    const task = await engine.tasks.create('test-copy');
    await engine.queue.add('test-copy', {
      taskId: task.id,
      op: 'test-copy',
      inputs: { file: [{ path: outside }] },
      params: { repeat: 1 },
    });
    const failed = await waitForTask(engine.tasks, task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /输入文件不在上传目录内/);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(outside, { force: true });
  }

  const escape = await postJson(`${engine.base}/api/test/escape`, { url: `${files.base}/a.mp4` });
  const escaped = await waitForTask(engine.tasks, escape.body.data!.taskId as string);
  assert.equal(escaped.status, 'failed');
  assert.match(escaped.error!, /产物不在输出目录内/);

  const gone = await engine.tasks.create('test-copy');
  await engine.queue.add('test-copy', {
    taskId: gone.id,
    op: 'test-copy',
    inputs: { file: [{ path: path.join(uploadDir, 'never-existed.mp4') }] },
    params: { repeat: 1 },
  });
  const missing = await waitForTask(engine.tasks, gone.id);
  assert.match(missing.error!, /上传的 file 文件已不存在/);

  const removed = await engine.tasks.create('test-removed-op');
  await engine.queue.add('test-removed-op', {
    taskId: removed.id,
    op: 'test-removed-op',
    inputs: {},
    params: {},
  });
  const unsupported = await waitForTask(engine.tasks, removed.id);
  assert.equal(unsupported.error, '服务端已不再支持操作 test-removed-op，请重新提交');
});

test('存储失败：任务 failed，产物被删除', async (t) => {
  if (skipWithoutRedis(t)) return;
  const broken = await startEngine({
    operations: allOps,
    storeOutputs: async () => {
      throw new Error('S3 上传失败: 503');
    },
  });
  try {
    const before = listOutputs().length;
    const res = await postJson(`${broken.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
    const task = await waitForTask(broken.tasks, res.body.data!.taskId as string);
    assert.equal(task.status, 'failed');
    assert.equal(task.error, 'S3 上传失败: 503');
    // 本地存储没有真正的上传，阶段停在操作自己的最后一个阶段
    assert.equal(task.phase, 'encoding');
    assert.equal(listOutputs().length, before);
  } finally {
    await broken.close();
  }
});

test('失败原因不带服务器目录：任务详情、SSE 用的记录和回调里只有文件名，接口路径保留', async (t) => {
  if (skipWithoutRedis(t)) return;
  webhookCalls.length = 0;
  const form = new FormData();
  form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  form.append('callbackUrl', 'http://127.0.0.1:9/hook');
  const res = await postForm(`${engine.base}/api/test/leak`, form);
  const taskId = res.body.data!.taskId as string;
  // 服务器日志里保留原文便于排查，给客户端的都去掉目录
  const task = await waitForTask(engine.tasks, taskId, (tk) => Boolean(tk.callback));
  assert.equal(task.status, 'failed');
  const root = path.dirname(uploadDir);
  for (const message of [
    task.error!,
    String((await getJson(`${engine.base}/api/tasks/${taskId}`)).body.data!.error),
    String(webhookCalls.find((c) => c.payload.task.id === taskId)!.payload.task.error),
  ]) {
    assert.equal(message.includes(root), false, message);
    assert.match(
      message,
      /^无法解析输入文件: [0-9a-f-]{36}\.mp4: Invalid data \| ENOENT: open 'list\.txt'（纯音频请用 \/api\/audio\/normalize）$/,
    );
  }
});

test('取消原因是调用方写的，原样保留', async (t) => {
  if (skipWithoutRedis(t)) return;
  const res = await postJson(`${engine.base}/api/test/wait`, { url: `${files.base}/a.mp4` });
  const taskId = res.body.data!.taskId as string;
  await waitForTask(engine.tasks, taskId, (task) => task.progress >= 48);
  const reason = '素材 /mnt/share/a/b.mp4 有误';
  const cancel = await postJson(`${engine.base}/api/tasks/${taskId}/cancel`, { reason });
  assert.equal(cancel.status, 200);
  assert.equal((await waitForTask(engine.tasks, taskId)).error, reason);
});

test('阶段：本地存储不出现 uploading，完成后保留操作自己的最后一个阶段；配置了 S3 才在上传时进入 uploading', async (t) => {
  if (skipWithoutRedis(t)) return;
  const phases = async (target: Engine) => {
    const res = await postJson(`${target.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
    const taskId = res.body.data!.taskId as string;
    const seen: string[] = [];
    const off = target.tasks.onProgress(taskId, (task) => seen.push(task.phase ?? ''));
    const done = await waitForTask(target.tasks, taskId);
    off();
    assert.equal(done.status, 'completed', done.error);
    return { seen, final: done.phase };
  };

  // test-copy 自己的阶段是 encoding（旧版 compose 完成后停在 merging 也是这个道理）
  const local = await phases(engine);
  assert.equal(local.seen.includes('uploading'), false, local.seen.join(','));
  assert.equal(local.final, 'encoding');

  const s3 = await startEngine({
    operations: allOps,
    storeOutputs: async (outputs) =>
      outputs.map((file) => ({
        path: file,
        url: `https://bucket.example.com/${path.basename(file)}`,
        size: 1,
        contentType: 'video/mp4',
        storage: 's3' as const,
        key: path.basename(file),
      })),
  });
  config.s3.bucket = 'test-bucket';
  try {
    const remote = await phases(s3);
    assert.ok(remote.seen.includes('uploading'), remote.seen.join(','));
    assert.equal(remote.final, 'uploading');
  } finally {
    config.s3.bucket = '';
    await s3.close();
  }
});

test('真实 ffmpeg：ctx.ffmpeg 的进度和产物在引擎里走通', { skip: ffmpegSkip }, async (t) => {
  if (skipWithoutRedis(t)) return;
  const dir = makeTempDir();
  try {
    const video = makeVideo(dir, 'in.mp4', { duration: 2 });
    const form = new FormData();
    form.append('file', fileBlob(fs.readFileSync(video), 'video/mp4'), 'in.mp4');
    const res = await postForm(`${engine.base}/api/test/scale`, form);
    const progress: number[] = [];
    const taskId = res.body.data!.taskId as string;
    const off = engine.tasks.onProgress(taskId, (task: Task) => progress.push(task.progress));
    const task = await waitForTask(engine.tasks, taskId, undefined, 30_000);
    off();
    assert.equal(task.status, 'completed', task.error);
    const media = await probeMedia(path.join(outputDir, task.outputs![0].name));
    assert.equal(media.video!.width, 160);
    assert.equal(media.video!.height, 120);
    assert.equal(media.audio, undefined);
    assert.ok(Math.abs(media.duration - 2) < 0.2);
    assert.equal(progress.at(-1), 100);
    assert.ok(task.outputs![0].size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
