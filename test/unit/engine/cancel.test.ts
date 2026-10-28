import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanupRoot,
  fileBlob,
  getJson,
  hasStatus,
  listOutputs,
  postForm,
  postJson,
  redisAvailable,
  sendJson,
  startEngine,
  startFileServer,
  startWorker,
  uploadDir,
  waitFor,
  waitForEmptyDir,
  waitForTask,
  type Engine,
} from './harness';
import { allOps, allocatedBy } from './fake-ops';
import { ffmpegSkip, makeTempDir, makeVideo } from '../../helpers/media';
import type { DeliverWebhook } from '../../../src/core/webhook-dispatcher';
import { getOperation } from '../../../src/operations';
import type { JobQueue } from '../../../src/services/queue.service';

const CLIP = Buffer.alloc(2048, 7);
let redisUp = false;
let engine: Engine;
let files: Awaited<ReturnType<typeof startFileServer>>;

const webhookEvents: { taskId: string; event: string; error?: string }[] = [];
const deliverSpy: DeliverWebhook = async (_url, payload, opts) => {
  const { task } = payload as { task: { id: string; error?: string } };
  webhookEvents.push({ taskId: task.id, event: opts?.event ?? '', error: task.error });
  return { delivered: true, attempts: 1, status: 200 };
};

before(async () => {
  redisUp = await redisAvailable();
  files = await startFileServer({ '/a.mp4': CLIP });
  if (redisUp) engine = await startEngine({ operations: allOps, deliverWebhook: deliverSpy });
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

function uploadForm(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

/** job 进入 BullMQ 的终态（处理函数返回或抛错）：说明 ffmpeg 已退出、现场已清理 */
async function waitForJobDone(queue: JobQueue, id: string, timeoutMs = 5000): Promise<string> {
  let state = '';
  await waitFor(async () => {
    state = (await (await queue.getJob(id))?.getState()) ?? 'missing';
    return state === 'failed' || state === 'completed' || state === 'missing';
  }, timeoutMs);
  return state;
}

test('取消排队中的任务：从队列删除，任务 cancelled 带原因，上传文件删除，投递 task.cancelled', async (t) => {
  if (skipWithoutRedis(t)) return;
  const idle = await startEngine({ operations: allOps, worker: false, deliverWebhook: deliverSpy });
  try {
    const submit = await postForm(
      `${idle.base}/api/test/copy`,
      uploadForm({ callbackUrl: 'http://127.0.0.1:9/hook' }),
    );
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    const taskId = submit.body.data!.taskId as string;
    assert.ok(await idle.queue.getJob(taskId));
    assert.equal(fs.readdirSync(uploadDir).length, 1);

    const res = await postJson(`${idle.base}/api/tasks/${taskId}/cancel`, { reason: ' 不要了 ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data!.status, 'cancelled');
    assert.equal(res.body.data!.error, '不要了');
    assert.ok(res.body.data!.completedAt);
    assert.equal(await idle.queue.getJob(taskId), undefined);
    assert.deepEqual(await waitForEmptyDir(uploadDir), []);
    await waitFor(() => webhookEvents.some((e) => e.taskId === taskId));
    assert.deepEqual(
      webhookEvents.filter((e) => e.taskId === taskId),
      [{ taskId, event: 'task.cancelled', error: '不要了' }],
    );

    // 再取消一次：409，带当前任务
    const again = await postJson(`${idle.base}/api/tasks/${taskId}/cancel`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error, '任务已经取消过了');
    assert.equal(again.body.data!.status, 'cancelled');

    // DELETE 等价，不带请求体时用默认原因
    const second = await postJson(`${idle.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
    const secondId = second.body.data!.taskId as string;
    const deleted = await sendJson('DELETE', `${idle.base}/api/tasks/${secondId}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data!.status, 'cancelled');
    assert.equal(deleted.body.data!.error, '任务已取消');
    assert.equal((await idle.queue.getJobCounts('waiting')).waiting, 0);

    assert.equal((await sendJson('DELETE', `${idle.base}/api/tasks/nope`)).status, 404);
    const missing = await postJson(`${idle.base}/api/tasks/nope/cancel`, {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, '任务不存在');
    const badReason = await postJson(`${idle.base}/api/tasks/${secondId}/cancel`, { reason: 5 });
    assert.equal(badReason.status, 400);
    assert.equal(badReason.body.error, 'reason 必须是字符串');
    const longReason = await postJson(`${idle.base}/api/tasks/${secondId}/cancel`, {
      reason: 'x'.repeat(201),
    });
    assert.equal(longReason.body.error, 'reason 最长 200 个字符');
  } finally {
    await idle.close();
  }
});

test('取消执行中的任务：广播到 Worker，中止执行，已分配的产物和上传文件删除', async (t) => {
  if (skipWithoutRedis(t)) return;
  const submit = await postForm(
    `${engine.base}/api/test/wait`,
    uploadForm({ callbackUrl: 'http://127.0.0.1:9/hook' }),
  );
  const taskId = submit.body.data!.taskId as string;
  await waitForTask(engine.tasks, taskId, (task) => task.progress === 48);
  const started = Date.now();
  const res = await sendJson('DELETE', `${engine.base}/api/tasks/${taskId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data!.status, 'cancelled');
  assert.equal(res.body.data!.progress, 48);
  // 等待中的 fake 操作 10 秒后才会自己结束，广播应立即中止它
  assert.equal(await waitForJobDone(engine.queue, taskId, 3000), 'failed');
  assert.ok(Date.now() - started < 3000);
  for (const p of allocatedBy.get(taskId)!) assert.equal(fs.existsSync(p), false);
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);
  const task = await engine.tasks.get(taskId);
  assert.equal(task!.status, 'cancelled');
  assert.equal(task!.error, '任务已取消');
  // 回调只投递一次：取消接口写了终态，Worker 收尾时的 finish 不再生效
  await waitFor(() => webhookEvents.some((e) => e.taskId === taskId));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    webhookEvents.filter((e) => e.taskId === taskId).map((e) => e.event),
    ['task.cancelled'],
  );
});

test('多实例：没有 Worker 的 API 实例能取消另一个实例正在执行的任务', async (t) => {
  if (skipWithoutRedis(t)) return;
  const api = await startEngine({ operations: allOps, worker: false });
  const remote = await startWorker(api, allOps);
  try {
    const submit = await postJson(`${api.base}/api/test/wait`, { url: `${files.base}/a.mp4` });
    const taskId = submit.body.data!.taskId as string;
    await waitForTask(api.tasks, taskId, (task) => task.progress >= 50);
    const res = await postJson(`${api.base}/api/tasks/${taskId}/cancel`, { reason: '跨实例取消' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // 定时检查的兜底要 5 秒，2 秒内结束说明是广播生效
    assert.equal(await waitForJobDone(api.queue, taskId, 2000), 'failed');
    for (const p of allocatedBy.get(taskId)!) assert.equal(fs.existsSync(p), false);
    const task = await api.tasks.get(taskId);
    assert.equal(task!.error, '跨实例取消');
  } finally {
    await remote.close();
    await api.close();
  }
});

test('广播收不到时（例如订阅连接正在重连），Worker 定时查到任务已结束也会停下', async (t) => {
  if (skipWithoutRedis(t)) return;
  const polling = await startEngine({ operations: allOps, cancelPollMs: 150 });
  try {
    const submit = await postJson(`${polling.base}/api/test/wait`, { url: `${files.base}/a.mp4` });
    const taskId = submit.body.data!.taskId as string;
    await waitForTask(polling.tasks, taskId, (task) => task.progress >= 50);
    // 绕过取消接口直接写终态，模拟广播丢失
    await polling.tasks.finish(taskId, { status: 'cancelled', error: '外部取消' });
    assert.equal(await waitForJobDone(polling.queue, taskId, 3000), 'failed');
    for (const p of allocatedBy.get(taskId)!) assert.equal(fs.existsSync(p), false);
    assert.equal((await polling.tasks.get(taskId))!.error, '外部取消');
  } finally {
    await polling.close();
  }
});

test('已结束的任务不能取消：409，带当前状态', async (t) => {
  if (skipWithoutRedis(t)) return;
  const ok = await postJson(`${engine.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
  const okId = ok.body.data!.taskId as string;
  await waitForTask(engine.tasks, okId, hasStatus('completed'));
  const completed = await postJson(`${engine.base}/api/tasks/${okId}/cancel`, {});
  assert.equal(completed.status, 409);
  assert.equal(completed.body.error, '任务已完成，不能取消');
  assert.equal(completed.body.data!.status, 'completed');
  assert.ok(Array.isArray(completed.body.data!.outputs));

  const bad = await postJson(`${engine.base}/api/test/fail`, { url: `${files.base}/a.mp4` });
  const badId = bad.body.data!.taskId as string;
  await waitForTask(engine.tasks, badId, hasStatus('failed'));
  const failed = await sendJson('DELETE', `${engine.base}/api/tasks/${badId}`);
  assert.equal(failed.status, 409);
  assert.equal(failed.body.error, '任务已失败，不能取消');
  assert.equal(failed.body.data!.error, '故意失败');
  // 取消失败不改动任务
  assert.equal((await getJson(`${engine.base}/api/tasks/${badId}`)).body.data!.status, 'failed');
});

test(
  '真实 ffmpeg：取消正在编码的 transcode，ffmpeg 被杀掉，没有留下产物',
  { skip: ffmpegSkip },
  async (t) => {
    if (skipWithoutRedis(t)) return;
    const transcode = getOperation('transcode')!;
    const real = await startEngine({ operations: [transcode] });
    const dir = makeTempDir();
    try {
      const video = makeVideo(dir, 'long.mp4', { size: '640x480', duration: 12 });
      const before = listOutputs().length;
      const form = new FormData();
      form.append('file', fileBlob(fs.readFileSync(video), 'video/mp4'), 'long.mp4');
      form.append('videoCodec', 'h265');
      form.append('preset', 'slow');
      const submit = await postForm(`${real.base}/api/transcode`, form);
      assert.equal(submit.status, 200, JSON.stringify(submit.body));
      const taskId = submit.body.data!.taskId as string;
      const running = await waitForTask(real.tasks, taskId, (task) => task.progress >= 3, 30_000);
      assert.equal(running.status, 'processing');

      const started = Date.now();
      const res = await postJson(`${real.base}/api/tasks/${taskId}/cancel`, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const cancelledAt = res.body.data!.progress as number;
      assert.ok(cancelledAt < 90, `取消时进度 ${cancelledAt}%，编码太快，测试没有意义`);
      // 处理函数要等 ffmpeg 进程退出才返回，job 结束就说明进程已经被杀掉
      assert.equal(await waitForJobDone(real.queue, taskId, 5000), 'failed');
      assert.ok(Date.now() - started < 5000);
      const task = await real.tasks.get(taskId);
      assert.equal(task!.status, 'cancelled');
      assert.equal(task!.outputs, undefined);
      assert.equal(listOutputs().length, before);
      assert.equal(fs.existsSync(path.join(uploadDir, taskId)), false);
      assert.deepEqual(await waitForEmptyDir(uploadDir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await real.close();
    }
  },
);
