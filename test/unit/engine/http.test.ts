import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import IORedis from 'ioredis';
import { EventSource } from 'undici';
import { z } from 'zod';
import {
  TEST_REDIS_URL,
  cleanupRoot,
  fileBlob,
  getJson,
  listOutputs,
  postForm,
  postJson,
  redisAvailable,
  startEngine,
  startFileServer,
  uploadDir,
  waitFor,
  waitForEmptyDir,
  waitForTask,
  type Engine,
} from './harness';
import { allOps, allocatedBy } from './fake-ops';
import { createApp, type AppOptions } from '../../../src/app';
import { config } from '../../../src/config';
import { defineOperation } from '../../../src/operations/types';
import { numberParam } from '../../../src/schemas/coerce';
import { createJobQueue } from '../../../src/services/queue.service';
import { TaskService } from '../../../src/services/task.service';
import type { Task } from '../../../src/types';

const CLIP = Buffer.alloc(4096, 3);
let redisUp = false;
let engine: Engine;
let files: Awaited<ReturnType<typeof startFileServer>>;

before(async () => {
  redisUp = await redisAvailable();
  files = await startFileServer({ '/clip.mp4': CLIP, '/a.mp4': CLIP, '/b.mp4': CLIP });
  if (redisUp) engine = await startEngine({ operations: allOps });
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

test('multipart 上传 → 任务完成，outputs / downloadUrl 可下载，上传文件被清理', async (t) => {
  if (skipWithoutRedis(t)) return;
  const form = new FormData();
  form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  form.append('repeat', '2');
  form.append('label', '');
  const submit = await postForm(`${engine.base}/api/test/copy`, form);
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  assert.equal(submit.body.success, true);
  const taskId = submit.body.data!.taskId as string;
  assert.equal(submit.body.data!.status, 'pending');

  const done = await waitForTask(engine.tasks, taskId);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.type, 'test-copy');

  const view = await getJson(`${engine.base}/api/tasks/${taskId}`);
  assert.equal(view.status, 200);
  const data = view.body.data!;
  assert.equal(data.progress, 100);
  assert.equal(data.inputFiles, undefined);
  assert.equal(typeof data.elapsedSeconds, 'number');
  const result = data.result as { size: number; inputName: string; label: null };
  assert.equal(result.size, CLIP.length);
  assert.equal(result.label, null);
  // 上传文件保留原扩展名（小写），文件名是随机 UUID
  assert.match(result.inputName, /^[0-9a-f-]{36}\.mp4$/);
  const outputs = data.outputs as Task['outputs'];
  assert.equal(outputs!.length, 2);
  for (const output of outputs!) {
    assert.match(output.name, /^[0-9a-f-]{36}\.mp4$/);
    assert.equal(output.url, `/api/files/${output.name}`);
    assert.equal(output.storage, 'local');
    assert.equal(JSON.stringify(output).includes(config.outputDir), false);
  }
  assert.deepEqual(
    data.downloadUrl,
    outputs!.map((o) => o.url),
  );
  assert.equal(data.primaryUrl, outputs![0].url);
  // 旧字段 output 是逗号分隔的产物相对路径（与 outputs[].name 相同），不暴露服务器目录
  assert.equal(data.output, outputs!.map((o) => o.name).join(','));
  assert.equal(JSON.stringify(data).includes(config.outputDir), false);
  assert.equal(JSON.stringify(data).includes(path.dirname(config.outputDir)), false);

  const download = await fetch(`${engine.base}${outputs![0].url}`);
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).length, CLIP.length);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

  // 上传文件和 workDir 在任务结束后删除
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);
});

test('URL 输入：下载链接 → 任务完成，进度单调递增并经过 downloading 阶段', async (t) => {
  if (skipWithoutRedis(t)) return;
  const progress: { progress: number; phase?: string }[] = [];
  const submit = await postJson(`${engine.base}/api/test/copy`, {
    url: `${files.base}/clip.mp4`,
    repeat: 1,
  });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const taskId = submit.body.data!.taskId as string;
  const off = engine.tasks.onProgress(taskId, (task) =>
    progress.push({ progress: task.progress, phase: task.phase }),
  );
  const done = await waitForTask(engine.tasks, taskId);
  off();
  assert.equal(done.status, 'completed', done.error);
  assert.equal((done.result as { size: number }).size, CLIP.length);
  // 链接里的扩展名保留给 ffmpeg 判断格式
  assert.match((done.result as { inputName: string }).inputName, /^input-0\.mp4$/);
  assert.equal(files.hits.get('/clip.mp4'), 1);
  const values = progress.map((p) => p.progress);
  assert.deepEqual(
    values,
    [...values].sort((a, b) => a - b),
    `进度应单调递增: ${values.join(',')}`,
  );
  assert.equal(values.at(-1), 100);
  const phases = new Set(progress.map((p) => p.phase));
  assert.ok(phases.has('encoding') || phases.has('uploading'), [...phases].join(','));
});

test('URL 输入：多文件槽接受数组，fileUrl 别名也可用', async (t) => {
  if (skipWithoutRedis(t)) return;
  const multi = await postJson(`${engine.base}/api/test/multi`, {
    filesUrls: [`${files.base}/a.mp4`, `${files.base}/b.mp4`],
    imageUrl: `${files.base}/clip.mp4`,
  });
  assert.equal(multi.status, 200, JSON.stringify(multi.body));
  const done = await waitForTask(engine.tasks, multi.body.data!.taskId as string);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(done.result, { count: 2, hasImage: true });

  const alias = await postJson(`${engine.base}/api/test/copy`, { fileUrl: `${files.base}/a.mp4` });
  assert.equal(alias.status, 200, JSON.stringify(alias.body));
  const aliasDone = await waitForTask(engine.tasks, alias.body.data!.taskId as string);
  assert.equal(aliasDone.status, 'completed', aliasDone.error);
});

test('多文件产物：子目录里的文件都在 outputs 里，primary 指定主产物', async (t) => {
  if (skipWithoutRedis(t)) return;
  const form = new FormData();
  form.append('file', fileBlob('hello', 'text/plain'), 'sub.srt');
  const submit = await postForm(`${engine.base}/api/test/dir`, form);
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const done = await waitForTask(engine.tasks, submit.body.data!.taskId as string);
  assert.equal(done.status, 'completed', done.error);
  const names = done.outputs!.map((o) => o.name);
  assert.equal(names.length, 2);
  assert.match(names[0], /^[0-9a-f-]{36}\/a\.txt$/);
  assert.equal(done.primaryUrl, `/api/files/${names[1]}`);
  const playlist = await fetch(`${engine.base}${done.primaryUrl}`);
  assert.equal(playlist.status, 200);
  assert.equal(await playlist.text(), '#EXTM3U\n');
});

test('SAVE_OUTPUT_FILE=false：顶层文件下载一次后删除，子目录里的文件保留', async (t) => {
  if (skipWithoutRedis(t)) return;
  const form = new FormData();
  form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  const top = await postForm(`${engine.base}/api/test/copy`, form);
  const dirForm = new FormData();
  dirForm.append('file', fileBlob('x', 'text/plain'), 'x.vtt');
  const nested = await postForm(`${engine.base}/api/test/dir`, dirForm);
  const topTask = await waitForTask(engine.tasks, top.body.data!.taskId as string);
  const dirTask = await waitForTask(engine.tasks, nested.body.data!.taskId as string);

  config.saveOutputFile = false;
  try {
    const url = `${engine.base}${topTask.outputs![0].url}`;
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(url)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await fetch(url)).status, 404);

    const nestedUrl = `${engine.base}${dirTask.primaryUrl}`;
    await (await fetch(nestedUrl)).text();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await fetch(nestedUrl)).status, 200);
  } finally {
    config.saveOutputFile = true;
  }
});

test('400：参数不合法、缺输入、上传和链接混用、文件过多过少、链接不合法，上传文件都被清理', async (t) => {
  if (skipWithoutRedis(t)) return;
  const copy = `${engine.base}/api/test/copy`;

  const bad = new FormData();
  bad.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  bad.append('repeat', '9');
  const badParam = await postForm(copy, bad);
  assert.equal(badParam.status, 400);
  assert.equal(badParam.body.error, 'repeat 必须是 1 到 3 之间的整数');

  const missing = await postJson(copy, { repeat: 1 });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, '请上传 file 文件，或提供 url / fileUrl 链接');

  const both = new FormData();
  both.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  both.append('url', `${files.base}/clip.mp4`);
  const mixed = await postForm(copy, both);
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error!, /file 不能同时上传文件和提供链接/);

  const twoUrls = await postJson(copy, {
    url: `${files.base}/a.mp4`,
    fileUrl: `${files.base}/b.mp4`,
  });
  assert.equal(twoUrls.status, 400);
  assert.equal(twoUrls.body.error, 'file 只能提供 1 个文件，收到 2 个');

  const many = new FormData();
  for (let i = 0; i < 4; i++) many.append('files', fileBlob(CLIP, 'video/mp4'), `c${i}.mp4`);
  const tooMany = await postForm(`${engine.base}/api/test/multi`, many);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, '上传参数错误: files 最多上传 3 个文件');

  const tooManyUrls = await postJson(`${engine.base}/api/test/multi`, {
    filesUrls: Array.from({ length: 4 }, (_, i) => `${files.base}/${i}.mp4`),
  });
  assert.equal(tooManyUrls.status, 400);
  assert.equal(tooManyUrls.body.error, 'files 最多 3 个文件，收到 4 个');

  const one = new FormData();
  one.append('files', fileBlob(CLIP, 'audio/mpeg'), 'a.mp3');
  const tooFew = await postForm(`${engine.base}/api/test/multi`, one);
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.body.error, 'files 至少需要 2 个文件（上传或链接），收到 1 个');

  const noFiles = await postJson(`${engine.base}/api/test/multi`, {});
  assert.equal(noFiles.body.error, '请上传 files 文件（2-3 个），或提供 filesUrls 链接');

  const wrong = new FormData();
  wrong.append('file', fileBlob('text'), 'notes.txt');
  const wrongKind = await postForm(copy, wrong);
  assert.equal(wrongKind.status, 400);
  assert.match(
    wrongKind.body.error!,
    /不支持的文件类型: application\/octet-stream（notes\.txt），file 只接受视频文件/,
  );

  const wrongField = new FormData();
  wrongField.append('video', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  const unexpected = await postForm(copy, wrongField);
  assert.equal(unexpected.status, 400);
  assert.match(unexpected.body.error!, /不接受文件字段 video，本接口的文件字段: file（最多 1 个）/);

  const ftp = await postJson(copy, { url: 'ftp://example.com/a.mp4' });
  assert.equal(ftp.status, 400);
  assert.match(ftp.body.error!, /url 不是有效的 http \/ https 链接/);

  const notString = await postJson(copy, { url: 42 });
  assert.equal(notString.body.error, 'url 必须是链接字符串或字符串数组');

  const misplaced = await postJson(copy, { file: `${files.base}/a.mp4` });
  assert.equal(misplaced.status, 400);
  assert.match(misplaced.body.error!, /file 字段只能上传文件.*url \/ fileUrl/);

  const callback = await postJson(copy, {
    url: `${files.base}/a.mp4`,
    callbackUrl: 'javascript:alert(1)',
  });
  assert.equal(callback.status, 400);
  assert.match(callback.body.error!, /callbackUrl 不是有效的 http \/ https 链接/);

  const arrayBody = await postJson(copy, [1, 2]);
  assert.equal(arrayBody.body.error, '请求体必须是 JSON 对象');

  const cross = await postJson(`${engine.base}/api/test/check`, {
    url: `${files.base}/a.mp4`,
    start: 5,
    end: 3,
  });
  assert.equal(cross.status, 400);
  assert.equal(cross.body.error, 'end 必须大于 start');

  // check 拿到每个槽的实际数量，没提供的槽为 0
  const provided = await postJson(`${engine.base}/api/test/check`, {
    url: `${files.base}/a.mp4`,
    start: 200,
  });
  assert.equal(provided.body.error, '没有字幕时 start 不能超过 100');

  // 没写自定义信息的 schema 也给出带字段名的中文提示
  const zodDefault = await postJson(copy, { url: `${files.base}/a.mp4`, label: 'x'.repeat(30) });
  assert.equal(zodDefault.status, 400);
  assert.match(zodDefault.body.error!, /^label: .*20/);

  assert.deepEqual(await waitForEmptyDir(uploadDir), []);
});

test('字幕槽接受 srt / text 类型，可选槽不提供时 ctx.inputs 里没有它', async (t) => {
  if (skipWithoutRedis(t)) return;
  const form = new FormData();
  form.append('file', fileBlob(CLIP), 'clip.MOV');
  form.append('subtitle', fileBlob('1\n00:00:00,000 --> 00:00:01,000\nhi\n'), 'sub.srt');
  const withSub = await postForm(`${engine.base}/api/test/check`, form);
  assert.equal(withSub.status, 200, JSON.stringify(withSub.body));
  const done = await waitForTask(engine.tasks, withSub.body.data!.taskId as string);
  assert.deepEqual(done.result, { subtitle: true });

  const plain = new FormData();
  plain.append('file', fileBlob(CLIP, 'video/quicktime'), 'blob');
  const withoutSub = await postForm(`${engine.base}/api/test/check`, plain);
  const done2 = await waitForTask(engine.tasks, withoutSub.body.data!.taskId as string);
  assert.deepEqual(done2.result, { subtitle: false });

  const badSub = new FormData();
  badSub.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  badSub.append('subtitle', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  const rejected = await postForm(`${engine.base}/api/test/check`, badSub);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error!, /subtitle 只接受字幕（srt \/ ass \/ ssa \/ vtt）文件/);
});

test('同步操作：在请求里执行并返回 data，上传文件和产物都被清理', async (t) => {
  if (skipWithoutRedis(t)) return;
  const before = listOutputs().length;
  const form = new FormData();
  form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  const res = await postForm(`${engine.base}/api/test/sync`, form);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { success: true, data: { size: CLIP.length } });
  const stray = allocatedBy.get('test-sync')![0];
  assert.equal(fs.existsSync(stray), false);
  assert.equal(listOutputs().length, before);
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);

  const byUrl = await postJson(`${engine.base}/api/test/sync`, { url: `${files.base}/clip.mp4` });
  assert.deepEqual(byUrl.body, { success: true, data: { size: CLIP.length } });
});

test('同步操作：超过 SYNC_TIMEOUT 返回 504 并中止执行', async (t) => {
  if (skipWithoutRedis(t)) return;
  const original = config.syncTimeoutMs;
  config.syncTimeoutMs = 300;
  try {
    const res = await postJson(`${engine.base}/api/test/sync`, {
      url: `${files.base}/clip.mp4`,
      mode: 'slow',
    });
    assert.equal(res.status, 504);
    assert.match(res.body.error!, /处理超时/);
    const stray = allocatedBy.get('test-sync')![0];
    assert.equal(fs.existsSync(stray), false);
  } finally {
    config.syncTimeoutMs = original;
  }
});

test('队列已满返回 429，未满时正常入队', async (t) => {
  if (skipWithoutRedis(t)) return;
  // 没有 Worker 的引擎，job 一直排着
  const idle = await startEngine({ operations: allOps, worker: false });
  config.maxQueueLength = 2;
  try {
    const submit = () => postJson(`${idle.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
    assert.equal((await submit()).status, 200);
    assert.equal((await submit()).status, 200);
    const full = await submit();
    assert.equal(full.status, 429);
    assert.equal(full.body.error, '任务队列已满，请稍后重试');
    const counts = await idle.queue.getJobCounts('waiting');
    assert.equal(counts.waiting, 2);
  } finally {
    config.maxQueueLength = 0;
    await idle.close();
  }
});

test('入队的 job：jobId 等于 taskId，payload 只含解析后的参数和输入', async (t) => {
  if (skipWithoutRedis(t)) return;
  const idle = await startEngine({ operations: allOps, worker: false });
  try {
    const res = await postJson(`${idle.base}/api/test/copy`, {
      url: ` ${files.base}/a.mp4 `,
      repeat: '2',
      callbackUrl: 'http://127.0.0.1:1/hook',
      unknownField: 'dropped',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const taskId = res.body.data!.taskId as string;
    const job = await idle.queue.getJob(taskId);
    assert.ok(job);
    assert.equal(job.name, 'test-copy');
    assert.deepEqual(job.data, {
      taskId,
      op: 'test-copy',
      inputs: { file: [{ url: `${files.base}/a.mp4` }] },
      params: { repeat: 2 },
      callbackUrl: 'http://127.0.0.1:1/hook',
    });
    const task = await idle.tasks.get(taskId);
    assert.equal(task!.callbackUrl, 'http://127.0.0.1:1/hook');
  } finally {
    await idle.close();
  }
});

test('SSE：推送当前状态和后续进度，终态后关闭连接', async (t) => {
  if (skipWithoutRedis(t)) return;
  const submit = await postJson(`${engine.base}/api/test/wait`, { url: `${files.base}/a.mp4` });
  const taskId = submit.body.data!.taskId as string;
  await waitForTask(engine.tasks, taskId, (task) => task.progress >= 50);

  const res = await fetch(`${engine.base}/api/tasks/${taskId}/progress`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const first = await reader.read();
  text += decoder.decode(first.value);
  assert.match(text, /"status":"processing"/);

  engine.worker!.cancelJob(taskId, '测试取消');
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  const events = text
    .split('\n\n')
    .filter((e) => e.startsWith('data: '))
    .map((e) => JSON.parse(e.slice(6)) as { status: string; error?: string });
  assert.equal(events.at(-1)!.status, 'cancelled');
  assert.equal(events.at(-1)!.error, '测试取消');

  // 终态任务直接返回一次并关闭；终态事件后单独一段 id（不带 data，EventSource 不会多派发消息）
  const again = await fetch(`${engine.base}/api/tasks/${taskId}/progress`);
  const body = await again.text();
  const blocks = body.split('\n\n').filter(Boolean);
  assert.equal(blocks.filter((b) => b.startsWith('data: ')).length, 1);
  assert.match(body, /"status":"cancelled"/);
  assert.equal(blocks.at(-1), 'id: cancelled');
});

test('SSE：已收到终态的 EventSource 重连时回 204，旧客户端不会对已取消的任务无限重连', async (t) => {
  if (skipWithoutRedis(t)) return;
  const submit = await postJson(`${engine.base}/api/test/wait`, { url: `${files.base}/a.mp4` });
  const taskId = submit.body.data!.taskId as string;
  await waitForTask(engine.tasks, taskId, (task) => task.progress >= 50);
  const cancel = await postJson(`${engine.base}/api/tasks/${taskId}/cancel`, {});
  assert.equal(cancel.status, 200);
  const url = `${engine.base}/api/tasks/${taskId}/progress`;

  // 带着终态的 Last-Event-ID 来重连：204，按 SSE 规范 EventSource 不再重连
  const reconnect = await fetch(url, { headers: { 'last-event-id': 'cancelled' } });
  assert.equal(reconnect.status, 204);
  assert.equal(await reconnect.text(), '');
  // 断线时还没收到终态（Last-Event-ID 不是当前终态）：照常把终态发给它
  const missed = await fetch(url, { headers: { 'last-event-id': 'something-else' } });
  assert.equal(missed.status, 200);
  assert.match(await missed.text(), /"status":"cancelled"/);

  // 真实的 EventSource 加上旧版 README 的处理函数（只在 completed / failed 时 close）
  const es = new EventSource(url, { node: { reconnectionTime: 30 } });
  let opens = 0;
  const statuses: string[] = [];
  es.onopen = () => opens++;
  es.onmessage = (event) => {
    const data = JSON.parse(String(event.data)) as { status: string };
    statuses.push(data.status);
    if (data.status === 'completed' || data.status === 'failed') es.close();
  };
  try {
    await waitFor(() => es.readyState === EventSource.CLOSED, 3000);
    // 再等几个重连周期，确认不会再连上来
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(opens, 1);
    assert.deepEqual(statuses, ['cancelled']);
    assert.equal(es.readyState, EventSource.CLOSED);
  } finally {
    es.close();
  }
});

test('任务查询：不存在返回 404，未知接口返回 JSON 404，br 编码返回 415', async (t) => {
  if (skipWithoutRedis(t)) return;
  const missing = await getJson(`${engine.base}/api/tasks/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, '任务不存在');
  const sse = await getJson(`${engine.base}/api/tasks/nope/progress`);
  assert.equal(sse.status, 404);

  const unknown = await getJson(`${engine.base}/api/nope`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error!, /接口不存在: GET \/api\/nope/);

  const br = await fetch(`${engine.base}/api/test/copy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
    body: '{}',
  });
  assert.equal(br.status, 415);
});

test('GET /api/operations：列出操作、输入槽、链接字段和参数 JSON Schema', async (t) => {
  if (skipWithoutRedis(t)) return;
  const list = await getJson(`${engine.base}/api/operations`);
  assert.equal(list.status, 200);
  const ops = list.body.data as unknown as { name: string }[];
  assert.equal(ops.length, allOps.length);
  const one = await getJson(`${engine.base}/api/operations/test-copy`);
  const copy = one.body.data as {
    route: string;
    chainable: boolean;
    inputs: { urlFields: string[] }[];
    params: { properties: Record<string, { description?: string; maximum?: number }> };
  };
  assert.equal(copy.route, '/api/test/copy');
  assert.equal(copy.chainable, true);
  assert.deepEqual(copy.inputs[0].urlFields, ['url', 'fileUrl']);
  assert.equal(copy.params.properties.repeat.description, '复制几份');
  assert.equal(copy.params.properties.repeat.maximum, 3);
  assert.equal((await getJson(`${engine.base}/api/operations/nope`)).status, 404);
});

test('鉴权：/api 下除健康检查外都要过 auth，/api/files 只在 PROTECT_FILES 时鉴权', async (t) => {
  if (skipWithoutRedis(t)) return;
  const guarded = await startEngine({
    operations: allOps,
    worker: false,
    auth: (req, res, next) => {
      if (req.headers['x-api-key'] === 'k') return next();
      res.status(401).json({ success: false, error: '缺少或错误的 API Key' });
    },
  });
  try {
    const denied = await postJson(`${guarded.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
    assert.equal(denied.status, 401);
    const allowed = await postJson(
      `${guarded.base}/api/test/copy`,
      { url: `${files.base}/a.mp4` },
      { 'x-api-key': 'k' },
    );
    assert.equal(allowed.status, 200);
    assert.equal((await getJson(`${guarded.base}/api/tasks/x`)).status, 401);
    assert.equal((await getJson(`${guarded.base}/api/operations`)).status, 401);
    assert.notEqual((await fetch(`${guarded.base}/api/health`)).status, 401);
    assert.equal((await fetch(`${guarded.base}/api/files/none.mp4`)).status, 404);
    config.protectFiles = true;
    assert.equal((await fetch(`${guarded.base}/api/files/none.mp4`)).status, 401);
  } finally {
    config.protectFiles = false;
    await guarded.close();
  }
});

test('createApp：操作路由不在 /api 下或占用内置路由时启动失败', async () => {
  const { createApp } = await import('../../../src/app');
  const base = allOps[0];
  assert.throws(
    () => createApp({ operations: [{ ...base, route: '/admin/x' }], queue: {} as never }),
    /必须是 \/api\/ 下的固定路径/,
  );
  assert.throws(
    () => createApp({ operations: [{ ...base, route: '/api/tasks/x' }], queue: {} as never }),
    /占用了内置路由/,
  );
  assert.throws(
    () => createApp({ operations: [base, { ...base, route: '/api/other' }], queue: {} as never }),
    /操作名称重复/,
  );
});

async function serve(options: AppOptions): Promise<{ base: string; server: http.Server }> {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test('入队失败（Redis 不可用）：返回 503，删除已建的任务记录和上传文件，不触发回调', async (t) => {
  if (skipWithoutRedis(t)) return;
  const redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  const prefix = `ffsvc-test-${process.pid}-enqueue-fail:`;
  const tasks = new TaskService({ redis, keyPrefix: prefix });
  const terminal: Task[] = [];
  const off = tasks.onTerminal((task) => terminal.push(task));
  const queue = {
    add: async () => {
      throw new Error('Connection is closed.');
    },
    getJobCounts: async () => ({}),
  };
  const { base, server } = await serve({ operations: allOps, tasks, queue: queue as never });
  const error = console.error;
  console.error = () => {};
  try {
    const form = new FormData();
    form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
    form.append('callbackUrl', 'http://127.0.0.1:9/hook');
    const res = await postForm(`${base}/api/test/copy`, form);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, '任务服务暂时不可用，请稍后重试');
    assert.deepEqual(await redis.keys(`${prefix}*`), []);
    assert.deepEqual(terminal, []);
    assert.deepEqual(await waitForEmptyDir(uploadDir), []);
  } finally {
    console.error = error;
    off();
    await closeServer(server);
    redis.disconnect();
  }
});

test('默认鉴权 requireApiKey：健康检查放行，下载按 PROTECT_FILES，日志里的 api_key 打码', async (t) => {
  if (skipWithoutRedis(t)) return;
  const key = 'sk-engine-test-0123456789';
  config.apiKeys = [key];
  const { base, server } = await serve({
    operations: allOps,
    tasks: engine.tasks,
    queue: engine.queue,
  });
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.warn = () => {};
  try {
    assert.equal((await getJson(`${base}/api/tasks/nope`)).status, 401);
    assert.equal((await getJson(`${base}/api/tasks/nope?api_key=${key}`)).status, 404);
    assert.equal(
      (await getJson(`${base}/api/operations`, { authorization: `Bearer ${key}` })).status,
      200,
    );
    const denied = await postJson(`${base}/api/test/copy`, { url: `${files.base}/a.mp4` });
    assert.equal(denied.status, 401);
    assert.notEqual((await fetch(`${base}/api/health`)).status, 401);
    // 大小写不同的路径走同一套规则
    assert.equal((await fetch(`${base}/API/Tasks/nope`)).status, 401);

    assert.equal((await fetch(`${base}/api/files/none.mp4`)).status, 404);
    config.protectFiles = true;
    assert.equal((await fetch(`${base}/api/files/none.mp4`)).status, 401);
    assert.equal((await fetch(`${base}/API/FILES/none.mp4`)).status, 401);
    const withKey = await fetch(`${base}/api/files/none.mp4`, { headers: { 'x-api-key': key } });
    assert.equal(withKey.status, 404);

    const unknown = await getJson(`${base}/api/nope?api_key=${key}`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, '接口不存在: GET /api/nope');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const logged = lines.join('\n');
    assert.equal(logged.includes(key), false, logged);
    assert.match(logged, /GET \/api\/tasks\/nope\?api_key=\*\*\* 404/);
  } finally {
    console.log = log;
    console.warn = warn;
    config.apiKeys = [];
    config.protectFiles = false;
    await closeServer(server);
  }
});

test('同步操作：客户端断开时中止执行并清理产物和上传文件', async (t) => {
  if (skipWithoutRedis(t)) return;
  allocatedBy.delete('test-sync');
  const controller = new AbortController();
  const form = new FormData();
  form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
  form.append('mode', 'slow');
  const request = fetch(`${engine.base}/api/test/sync`, {
    method: 'POST',
    body: form,
    signal: controller.signal,
  });
  const deadline = Date.now() + 5000;
  while (!allocatedBy.has('test-sync') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stray = allocatedBy.get('test-sync')![0];
  assert.equal(fs.existsSync(stray), true);
  const started = Date.now();
  controller.abort();
  await assert.rejects(request);
  // 操作最长等 10 秒才自己结束；断开后应立即中止
  while (fs.existsSync(stray) && Date.now() - started < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(stray), false);
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);
});

/** 不需要 Redis 的桩：同步接口、健康检查这类用例用不到任务记录和队列 */
const stubTasks = { ping: async () => true } as unknown as TaskService;
const stubQueue = {
  add: async () => {
    throw new Error('不应入队');
  },
  getJobCounts: async () => ({}),
} as unknown as AppOptions['queue'];

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('Redis 不可用且设置了 MAX_QUEUE_LENGTH：提交几秒内返回 503 而不是一直挂着，上传文件被清理', async () => {
  // 队列的连接从未就绪：BullMQ 的命令不会发出，不加超时会一直等到 Redis 恢复
  const dead = `redis://127.0.0.1:${await freePort()}/0`;
  const options = { connectTimeout: 300, commandTimeout: 1000, retryStrategy: () => 100 };
  const queueRedis = new IORedis(dead, { ...options, maxRetriesPerRequest: 2 });
  const taskRedis = new IORedis(dead, { ...options, maxRetriesPerRequest: 1 });
  queueRedis.on('error', () => {});
  taskRedis.on('error', () => {});
  const queue = createJobQueue({ connection: queueRedis, prefix: `ffsvc-dead-${process.pid}` });
  const tasks = new TaskService({ redis: taskRedis });
  const { base, server } = await serve({ operations: allOps, tasks, queue, queueTimeoutMs: 1000 });
  const error = console.error;
  console.error = () => {};
  config.maxQueueLength = 5;
  try {
    const timed = async (url: string, init: RequestInit) => {
      const started = Date.now();
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { error?: string };
      return { status: res.status, error: body.error, ms: Date.now() - started };
    };
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const byUrl = await timed(`${base}/api/test/copy`, json({ url: `${files.base}/a.mp4` }));
    assert.equal(byUrl.status, 503);
    assert.equal(byUrl.error, '任务服务暂时不可用，请稍后重试');
    assert.ok(byUrl.ms < 5000, `${byUrl.ms}ms`);

    const form = new FormData();
    form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
    const upload = await timed(`${base}/api/test/copy`, { method: 'POST', body: form });
    assert.equal(upload.status, 503);
    assert.deepEqual(await waitForEmptyDir(uploadDir), []);

    const pipeline = await timed(
      `${base}/api/pipeline`,
      json({ url: `${files.base}/a.mp4`, steps: [{ op: 'test-copy' }] }),
    );
    assert.equal(pipeline.status, 503);
    assert.ok(pipeline.ms < 5000, `${pipeline.ms}ms`);
  } finally {
    config.maxQueueLength = 0;
    console.error = error;
    await closeServer(server);
    queueRedis.disconnect();
    taskRedis.disconnect();
    void queue.close().catch(() => {});
  }
});

const delayOp = defineOperation({
  name: 'test-sync-delay',
  route: '/api/test/sync-delay',
  title: '测试同步排队',
  description: '等一会儿再返回',
  sync: true,
  inputs: [],
  params: z.object({
    ms: numberParam('ms', { min: 0, max: 2000, int: true })
      .default(60)
      .meta({ description: '等待毫秒数' }),
  }),
  async run(_ctx, params) {
    await new Promise((resolve) => setTimeout(resolve, params.ms));
    return { files: [], data: { ok: true } };
  },
});

test('同步接口：并发满了的请求排队等空位，一批并行的 /api/info 式请求全部成功；排队也满了才 429', async () => {
  const original = config.maxConcurrentTasks;
  // 2 核服务器的默认值：旧版的上限是 max(4, 2×1) = 4，第 5 个起立刻 429
  config.maxConcurrentTasks = 1;
  const { base, server } = await serve({
    operations: [delayOp],
    tasks: stubTasks,
    queue: stubQueue,
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => postJson(`${base}/api/test/sync-delay`, {})),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      Array(30).fill(200),
    );
  } finally {
    config.maxConcurrentTasks = original;
    await closeServer(server);
  }

  // 并发 1、排队 1：第三个同时到的请求排不上队，429
  const small = await serve({
    operations: [delayOp],
    tasks: stubTasks,
    queue: stubQueue,
    syncLimits: { concurrency: 1, queue: 1 },
  });
  try {
    const three = await Promise.all(
      [0, 1, 2].map(() => postJson(`${small.base}/api/test/sync-delay`, { ms: 300 })),
    );
    const statuses = three.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.equal(three.find((r) => r.status === 429)!.body.error, '同步请求过多，请稍后重试');
    // 空位释放后又能正常处理
    assert.equal((await postJson(`${small.base}/api/test/sync-delay`, { ms: 0 })).status, 200);
  } finally {
    await closeServer(small.server);
  }
});

test('健康检查：ffmpeg / ffprobe 的检查有缓存，并发请求共用一次检查，不会按请求速率创建进程', async () => {
  const calls: string[] = [];
  const checkBinary = async (file: string) => {
    calls.push(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return true;
  };
  const { base, server } = await serve({
    operations: allOps,
    tasks: stubTasks,
    queue: stubQueue,
    checkBinary,
  });
  try {
    const burst = await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/api/health`)));
    assert.deepEqual(
      burst.map((r) => r.status),
      Array(30).fill(200),
    );
    assert.deepEqual(calls.sort(), [config.ffmpegPath, config.ffprobePath].sort());
    // 缓存期内再来一批也不再执行
    await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/api/health`)));
    assert.equal(calls.length, 2);
    const body = (await getJson(`${base}/api/health`)).body;
    assert.equal((body.data as { ffmpeg: string }).ffmpeg, 'available');
  } finally {
    await closeServer(server);
  }
});

test('同步接口：链接下载失败按原因回复 400 / 502，而不是 500', async () => {
  // 对方 4xx 是链接本身的问题，对方 5xx / 网络失败是上游问题；以前一律 500
  const upstream = net.createServer((socket) => {
    socket.end(
      'HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const retries = config.downloadRetries;
  config.downloadRetries = 0;
  const { base, server } = await serve({ operations: allOps, tasks: stubTasks, queue: stubQueue });
  try {
    const missing = await postJson(`${base}/api/test/sync`, { url: `${files.base}/missing.mp4` });
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error), /HTTP 404/);
    const port = (upstream.address() as AddressInfo).port;
    const broken = await postJson(`${base}/api/test/sync`, {
      url: `http://127.0.0.1:${port}/x.mp4`,
    });
    assert.equal(broken.status, 502);
    assert.match(String(broken.body.error), /HTTP 500/);
  } finally {
    config.downloadRetries = retries;
    upstream.close();
    await closeServer(server);
  }
});

test('健康检查：存储不可用（目录不可写、存储桶不可访问）时返回 503，结果有缓存', async () => {
  let storageCalls = 0;
  const { base, server } = await serve({
    operations: allOps,
    tasks: stubTasks,
    queue: stubQueue,
    checkBinary: async () => true,
    checkStorage: async () => {
      storageCalls++;
      return { ok: false, error: '输出目录不可写（EACCES）' };
    },
  });
  try {
    const first = await getJson(`${base}/api/health`);
    assert.equal(first.status, 503);
    assert.match(String(first.body.error), /存储（输出目录不可写（EACCES））/);
    assert.equal((first.body.data as { storageStatus: string }).storageStatus, 'unavailable');
    await getJson(`${base}/api/health`);
    assert.equal(storageCalls, 1);
  } finally {
    await closeServer(server);
  }
});

test('同步接口出错：响应里的错误信息不带服务器目录，提到的接口路径保留', async () => {
  const leakOp = defineOperation({
    name: 'test-sync-leak',
    route: '/api/test/sync-leak',
    title: '测试路径泄露',
    description: '报错信息里带输入文件的绝对路径',
    sync: true,
    inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
    params: z.object({}),
    async run(ctx) {
      // 上传的文件在 uploads 顶层；链接输入下载到同步请求自己的工作目录（uploads/sync-<id>/input-0.mp4）
      const file = ctx.inputs.file[0];
      throw new Error(`无法解析文件（异步处理请用 /api/test/copy）: ${file}: Invalid data`);
    },
  });
  const { base, server } = await serve({
    operations: [leakOp],
    tasks: stubTasks,
    queue: stubQueue,
  });
  const error = console.error;
  console.error = () => {};
  try {
    const form = new FormData();
    form.append('file', fileBlob(CLIP, 'video/mp4'), 'clip.mp4');
    const uploaded = await postForm(`${base}/api/test/sync-leak`, form);
    const byUrl = await postJson(`${base}/api/test/sync-leak`, { url: `${files.base}/a.mp4` });
    for (const [res, name] of [
      [uploaded, /[0-9a-f-]{36}\.mp4/],
      [byUrl, /input-0\.mp4/],
    ] as const) {
      assert.equal(res.status, 500);
      const message = res.body.error!;
      assert.equal(message.includes(uploadDir), false, message);
      assert.equal(message.includes(path.dirname(uploadDir)), false, message);
      assert.equal(message.includes('sync-'), false, message);
      assert.match(
        message,
        new RegExp(`^无法解析文件（异步处理请用 /api/test/copy）: ${name.source}: Invalid data$`),
      );
    }
    assert.deepEqual(await waitForEmptyDir(uploadDir), []);
  } finally {
    console.error = error;
    await closeServer(server);
  }
});

test('PUBLIC_BASE_URL：outputs[].url、primaryUrl 是绝对地址，旧字段 downloadUrl 仍是 /api/files/ 相对路径', async (t) => {
  if (skipWithoutRedis(t)) return;
  config.publicBaseUrl = 'https://media.example.com';
  try {
    const submit = await postJson(`${engine.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
    const taskId = submit.body.data!.taskId as string;
    await waitForTask(engine.tasks, taskId);
    const data = (await getJson(`${engine.base}/api/tasks/${taskId}`)).body.data!;
    const outputs = data.outputs as NonNullable<Task['outputs']>;
    assert.equal(outputs[0].url, `https://media.example.com/api/files/${outputs[0].name}`);
    assert.equal(data.primaryUrl, outputs[0].url);
    // 旧客户端按文档自己拼服务地址：BASE + downloadUrl[0]
    assert.deepEqual(data.downloadUrl, [`/api/files/${outputs[0].name}`]);
    assert.equal(data.output, outputs[0].name);
  } finally {
    config.publicBaseUrl = '';
  }
});
