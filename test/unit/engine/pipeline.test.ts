import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanupRoot,
  fileBlob,
  hasStatus,
  listOutputs,
  outputDir,
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
import { allocatedBy, pipelineOps, stampLog } from './fake-ops';
import { ffmpegSkip, makeTempDir, makeVideo } from '../../helpers/media';
import { isInside } from '../../../src/core/inputs';
import type { DeliverWebhook } from '../../../src/core/webhook-dispatcher';
import { getOperation, operations as registry } from '../../../src/operations';
import { probeMedia } from '../../../src/utils/media-probe';
import type { Task } from '../../../src/types';

const LOGO = Buffer.alloc(321, 1);
let redisUp = false;
let engine: Engine;
let files: Awaited<ReturnType<typeof startFileServer>>;
const PIPELINE = '/api/pipeline';

const webhooks: { taskId: string; event: string; steps?: unknown }[] = [];
const deliverSpy: DeliverWebhook = async (_url, payload, opts) => {
  const { task } = payload as { task: { id: string; steps?: unknown } };
  webhooks.push({ taskId: task.id, event: opts?.event ?? '', steps: task.steps });
  return { delivered: true, attempts: 1, status: 200 };
};

before(async () => {
  redisUp = await redisAvailable();
  files = await startFileServer({
    '/in.txt': Buffer.from('start'),
    '/logo.png': LOGO,
    '/sub.srt': Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nhi\n'),
  });
  if (redisUp) engine = await startEngine({ operations: pipelineOps, deliverWebhook: deliverSpy });
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

async function download(url: string): Promise<string> {
  const res = await fetch(`${engine.base}${url}`);
  assert.equal(res.status, 200);
  return res.text();
}

test('JSON：三步串联，上一步的主产物是下一步的 file，中间产物在 workDir 里并在结束后删除', async (t) => {
  if (skipWithoutRedis(t)) return;
  const before = listOutputs().length;
  const submit = await postJson(`${engine.base}${PIPELINE}`, {
    url: `${files.base}/in.txt`,
    callbackUrl: 'http://127.0.0.1:9/hook',
    steps: [
      { op: 'test-stamp', params: { tag: 'a' } },
      { op: 'test-stamp', params: { tag: 'b', progress: 'true' } },
      { op: 'test-stamp', params: { tag: 'c' }, inputs: { image: `${files.base}/logo.png` } },
    ],
  });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const taskId = submit.body.data!.taskId as string;
  const seen: { progress: number; steps: string }[] = [];
  const off = engine.tasks.onProgress(taskId, (task) =>
    seen.push({
      progress: task.progress,
      steps: (task.steps ?? []).map((s) => s.status[0]).join(''),
    }),
  );
  const done = await waitForTask(engine.tasks, taskId);
  off();
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.type, 'pipeline');
  assert.deepEqual(done.steps, [
    { op: 'test-stamp', status: 'completed' },
    { op: 'test-stamp', status: 'completed' },
    { op: 'test-stamp', status: 'completed' },
  ]);
  assert.deepEqual(done.result, { tag: 'c' });
  assert.equal(done.outputs!.length, 1);
  assert.equal(await download(done.primaryUrl!), `start|a|b|c+${LOGO.length}`);
  assert.equal(listOutputs().length, before + 1);
  assert.equal(files.hits.get('/logo.png'), 1);

  // 每一步的输入和产物位置
  const log = stampLog.get(taskId)!;
  const workDir = path.join(uploadDir, taskId);
  assert.equal(log.length, 3);
  assert.ok(isInside(workDir, log[0].input));
  assert.equal(log[1].input, log[0].output);
  assert.equal(log[2].input, log[1].output);
  assert.ok(isInside(path.join(workDir, 'step-1-output'), log[0].output));
  assert.ok(isInside(path.join(workDir, 'step-2-output'), log[1].output));
  // 最后一步也写在 workDir 里，完成后才移进输出目录（相对路径不变）
  assert.ok(isInside(path.join(workDir, 'step-3-output'), log[2].output));
  assert.equal(done.outputs![0].name, path.basename(log[2].output));
  assert.ok(fs.existsSync(path.join(outputDir, done.outputs![0].name)));
  assert.deepEqual(
    log.map((entry) => path.basename(entry.workDir)),
    ['step-1', 'step-2', 'step-3'],
  );
  // workDir 在写完终态之后才删（客户端先看到 completed），等一下
  await waitFor(() => !fs.existsSync(workDir), 3000);
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);

  // 进度单调递增到 100；步骤按顺序推进
  const values = seen.map((s) => s.progress);
  assert.deepEqual(
    values,
    [...values].sort((a, b) => a - b),
    values.join(','),
  );
  assert.equal(values.at(-1), 100);
  const order = [...new Set(seen.map((s) => s.steps))];
  assert.deepEqual(
    order,
    ['ppp', 'cpp', 'ccp', 'ccc'].filter((s) => order.includes(s)),
  );
  assert.ok(seen.some((s) => s.steps === 'cpp' || s.steps.startsWith('cp')));
  assert.ok(
    seen.some((s) => s.progress > 30 && s.progress < 70),
    '第二步时应汇报中间进度',
  );

  await waitFor(() => webhooks.some((w) => w.taskId === taskId));
  const hook = webhooks.find((w) => w.taskId === taskId)!;
  assert.equal(hook.event, 'task.completed');
  assert.equal((hook.steps as unknown[]).length, 3);
});

test('multipart：上传 file，steps 是 JSON 字符串；最后一步可以是多文件产物的操作', async (t) => {
  if (skipWithoutRedis(t)) return;
  const form = new FormData();
  form.append('file', fileBlob('hello', 'text/plain'), 'in.txt');
  form.append(
    'steps',
    JSON.stringify([{ op: 'test-stamp', params: { tag: 'm' } }, { op: 'test-dir' }]),
  );
  const submit = await postForm(`${engine.base}${PIPELINE}`, form);
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const done = await waitForTask(engine.tasks, submit.body.data!.taskId as string);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.outputs!.length, 2);
  assert.match(done.primaryUrl!, /index\.m3u8$/);
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);
});

test('第一步可以不是 chainable：主产物交给下一步；第一步没有产出文件时在执行时失败并指出步骤', async (t) => {
  if (skipWithoutRedis(t)) return;
  const ok = await postJson(`${engine.base}${PIPELINE}`, {
    url: `${files.base}/in.txt`,
    steps: [{ op: 'test-dir' }, { op: 'test-stamp' }],
  });
  const done = await waitForTask(engine.tasks, ok.body.data!.taskId as string);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(await download(done.primaryUrl!), '#EXTM3U\n|x');

  const bad = await postJson(`${engine.base}${PIPELINE}`, {
    url: `${files.base}/in.txt`,
    steps: [{ op: 'test-data' }, { op: 'test-stamp' }],
  });
  const failed = await waitForTask(engine.tasks, bad.body.data!.taskId as string);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '第 1 步（test-data）: 没有产出文件，无法作为下一步的输入');
  assert.deepEqual(
    failed.steps!.map((s) => s.status),
    ['failed', 'pending'],
  );
});

test('某一步失败：任务 failed，错误带步骤，前面步骤的中间产物和失败步骤的产物都被删除', async (t) => {
  if (skipWithoutRedis(t)) return;
  const before = listOutputs().length;
  const submit = await postJson(`${engine.base}${PIPELINE}`, {
    url: `${files.base}/in.txt`,
    steps: [{ op: 'test-stamp', params: { tag: 'a' } }, { op: 'test-fail' }],
  });
  const taskId = submit.body.data!.taskId as string;
  const failed = await waitForTask(engine.tasks, taskId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '第 2 步（test-fail）: 故意失败');
  assert.deepEqual(
    failed.steps!.map((s) => s.status),
    ['completed', 'failed'],
  );
  assert.equal(fs.existsSync(stampLog.get(taskId)![0].output), false);
  for (const p of allocatedBy.get(taskId)!) assert.equal(fs.existsSync(p), false);
  assert.equal(listOutputs().length, before);
});

test('中途取消：第 2 步执行时取消，步骤为 [completed, cancelled]，所有产物删除，投递 task.cancelled', async (t) => {
  if (skipWithoutRedis(t)) return;
  const before = listOutputs().length;
  const submit = await postJson(`${engine.base}${PIPELINE}`, {
    url: `${files.base}/in.txt`,
    callbackUrl: 'http://127.0.0.1:9/hook',
    steps: [{ op: 'test-stamp' }, { op: 'test-wait' }],
  });
  const taskId = submit.body.data!.taskId as string;
  const running = await waitForTask(
    engine.tasks,
    taskId,
    (task) => task.steps?.[1].status === 'processing' && allocatedBy.has(taskId),
  );
  assert.equal(running.status, 'processing');
  const intermediate = stampLog.get(taskId)![0].output;
  assert.equal(fs.existsSync(intermediate), true);

  const res = await postJson(`${engine.base}/api/tasks/${taskId}/cancel`, { reason: '中途取消' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // 取消接口写终态时，正在执行的那一步同时变成 cancelled
  assert.deepEqual(
    (res.body.data!.steps as Task['steps'])!.map((s) => s.status),
    ['completed', 'cancelled'],
  );
  await waitFor(() => !fs.existsSync(path.join(uploadDir, taskId)), 3000);
  assert.equal(fs.existsSync(intermediate), false);
  for (const p of allocatedBy.get(taskId)!) assert.equal(fs.existsSync(p), false);
  assert.equal(listOutputs().length, before);
  const task = await engine.tasks.get(taskId);
  assert.equal(task!.status, 'cancelled');
  assert.equal(task!.error, '中途取消');
  await waitFor(() => webhooks.some((w) => w.taskId === taskId));
  assert.equal(webhooks.find((w) => w.taskId === taskId)!.event, 'task.cancelled');
});

test('必填的附加输入由 inputs 提供（像 video.mix-audio 的 audio），所有链接一次下载', async (t) => {
  if (skipWithoutRedis(t)) return;
  const submit = await postJson(`${engine.base}${PIPELINE}`, {
    fileUrl: `${files.base}/in.txt`,
    steps: [
      { op: 'test-stamp', params: { tag: 'n' } },
      { op: 'test-needs', inputs: { extra: [`${files.base}/logo.png`, `${files.base}/sub.srt`] } },
    ],
  });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const done = await waitForTask(engine.tasks, submit.body.data!.taskId as string);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(await download(done.primaryUrl!), 'start|n|extra2');
});

test('提交时校验：400 指出第几步，上传文件被清理', async (t) => {
  if (skipWithoutRedis(t)) return;
  const url = `${files.base}/in.txt`;
  const submit = (body: unknown) => postJson(`${engine.base}${PIPELINE}`, body);
  const expect400 = async (body: unknown, error: string | RegExp) => {
    const res = await submit(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    if (typeof error === 'string') assert.equal(res.body.error, error);
    else assert.match(res.body.error!, error);
  };

  await expect400({ url }, /^请提供 steps/);
  await expect400({ url, steps: {} }, 'steps 必须是数组');
  await expect400({ url, steps: [] }, 'steps 至少需要 1 步');
  await expect400(
    { url, steps: Array.from({ length: 11 }, () => ({ op: 'test-stamp' })) },
    'steps 最多 10 步，收到 11 步',
  );
  await expect400({ steps: [{ op: 'test-stamp' }] }, '请上传 file 文件，或提供 url / fileUrl 链接');
  await expect400({ url, steps: ['test-stamp'] }, /^第 1 步必须是对象/);
  await expect400(
    { url, steps: [{ params: {} }] },
    '第 1 步缺少 op（操作名，见 GET /api/operations）',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp' }, { op: 'nope' }] },
    '第 2 步的操作 nope 不存在，可用操作见 GET /api/operations',
  );
  await expect400(
    { url, steps: [{ op: 'test-sync' }] },
    '第 1 步（test-sync）是同步接口，不能用于 pipeline',
  );
  await expect400(
    { url, steps: [{ op: 'test-multi' }] },
    '第 1 步（test-multi）没有单文件的 file 输入，不能用于 pipeline（多文件操作请单独调用）',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp' }, { op: 'test-dir' }, { op: 'test-stamp' }] },
    '第 2 步（test-dir）不产出单个主文件（chainable=false），只能作为 pipeline 的第一步或最后一步',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp' }, { op: 'test-copy', params: { repeat: 9 } }] },
    '第 2 步（test-copy）: repeat 必须是 1 到 3 之间的整数',
  );
  await expect400(
    { url, steps: [{ op: 'test-check', params: { start: 5, end: 3 } }] },
    '第 1 步（test-check）: end 必须大于 start',
  );
  // check 拿到附加输入的实际数量
  await expect400(
    { url, steps: [{ op: 'test-check', params: { start: 200 } }] },
    '第 1 步（test-check）: 没有字幕时 start 不能超过 100',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp', inputs: { logo: `${files.base}/logo.png` } }] },
    '第 1 步（test-stamp）: 没有输入 logo，可用的附加输入: image',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp' }, { op: 'test-stamp', inputs: { file: url } }] },
    '第 2 步（test-stamp）: file 由上一步的产物提供（第 1 步为提交的 file / url），不能写在 inputs 里',
  );
  await expect400(
    { url, steps: [{ op: 'test-needs' }] },
    '第 1 步（test-needs）: 缺少输入 extra（1-2 个），请在 inputs.extra 里提供链接',
  );
  await expect400(
    { url, steps: [{ op: 'test-needs', inputs: { extra: [url, url, url] } }] },
    '第 1 步（test-needs）: inputs.extra 最多 2 个链接，收到 3 个',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp', inputs: { image: 'ftp://x/logo.png' } }] },
    '第 1 步（test-stamp）的 inputs.image 不是有效的 http / https 链接: ftp://x/logo.png',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp', inputs: 'x' }] },
    /^第 1 步（test-stamp）: inputs 必须是对象/,
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp', params: { imageUrl: `${files.base}/logo.png` } }] },
    '第 1 步（test-stamp）: 链接输入请写在 inputs.image，而不是 params.imageUrl',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp' }, { op: 'test-stamp', params: { url } }] },
    '第 2 步（test-stamp）: 输入文件来自上一步（第 1 步为提交的 file / url），params 里不能有 url',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp', params: { callbackUrl: url } }] },
    '第 1 步（test-stamp）: callbackUrl 请写在请求顶层，而不是某一步的 params 里',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp', params: 'tag=a' }] },
    '第 1 步（test-stamp）: params 必须是对象',
  );
  await expect400(
    { url, steps: [{ op: 'test-stamp', param: { tag: 'a' } }] },
    '第 1 步（test-stamp）: 不支持的字段 param（只有 op、params、inputs）',
  );
  await expect400(
    { url, tag: 'a', steps: [{ op: 'test-stamp' }] },
    '不支持的字段: tag。每一步的参数请写在 steps[].params 里',
  );
  await expect400(
    { url, callbackUrl: 'javascript:x', steps: [{ op: 'test-stamp' }] },
    /^callbackUrl 不是有效的 http \/ https 链接/,
  );
  await expect400([{ op: 'test-stamp' }], '请求体必须是 JSON 对象');

  // 合法的附加输入数量能通过 check
  const withSub = await submit({
    url,
    steps: [
      { op: 'test-check', params: { start: 200 }, inputs: { subtitle: `${files.base}/sub.srt` } },
    ],
  });
  assert.equal(withSub.status, 200, JSON.stringify(withSub.body));

  // multipart：steps 不是合法 JSON；上传的文件类型不符合第一步的 file 槽
  const form = new FormData();
  form.append('file', fileBlob('x', 'text/plain'), 'notes.txt');
  form.append('steps', '[{op:"test-stamp"}]');
  const badJson = await postForm(`${engine.base}${PIPELINE}`, form);
  assert.equal(badJson.status, 400);
  assert.match(badJson.body.error!, /^steps 不是合法的 JSON: /);

  const kind = new FormData();
  kind.append('file', fileBlob('x', 'text/plain'), 'notes.txt');
  kind.append('steps', JSON.stringify([{ op: 'test-copy' }]));
  const wrongKind = await postForm(`${engine.base}${PIPELINE}`, kind);
  assert.equal(wrongKind.status, 400);
  assert.equal(
    wrongKind.body.error,
    '不支持的文件类型: text/plain（notes.txt），第 1 步（test-copy）的 file 只接受视频文件',
  );

  const both = new FormData();
  both.append('file', fileBlob('x', 'text/plain'), 'notes.txt');
  both.append('url', url);
  both.append('steps', JSON.stringify([{ op: 'test-stamp' }]));
  const mixed = await postForm(`${engine.base}${PIPELINE}`, both);
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error!, /file 不能同时上传文件和提供链接/);

  await waitForTask(engine.tasks, withSub.body.data!.taskId as string);
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);
});

test('入队的 job：名字是 pipeline，payload 含校验后的参数和附加输入，任务记录带 pending 的 steps', async (t) => {
  if (skipWithoutRedis(t)) return;
  const idle = await startEngine({ operations: pipelineOps, worker: false });
  try {
    const res = await postJson(`${idle.base}${PIPELINE}`, {
      url: ` ${files.base}/in.txt `,
      callbackUrl: 'http://127.0.0.1:1/hook',
      steps: [
        { op: 'test-copy', params: { repeat: '2', unknown: 1 } },
        { op: ' test-stamp ', params: { tag: '' }, inputs: { image: [`${files.base}/logo.png`] } },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const taskId = res.body.data!.taskId as string;
    const job = await idle.queue.getJob(taskId);
    assert.equal(job!.name, 'pipeline');
    assert.deepEqual(job!.data, {
      taskId,
      op: 'pipeline',
      inputs: { file: [{ url: `${files.base}/in.txt` }] },
      steps: [
        { op: 'test-copy', params: { repeat: 2 }, inputs: {} },
        {
          op: 'test-stamp',
          params: { tag: 'x', progress: false },
          inputs: { image: [{ url: `${files.base}/logo.png` }] },
        },
      ],
      callbackUrl: 'http://127.0.0.1:1/hook',
    });
    const task = await idle.tasks.get(taskId);
    assert.equal(task!.type, 'pipeline');
    assert.deepEqual(task!.steps, [
      { op: 'test-copy', status: 'pending' },
      { op: 'test-stamp', status: 'pending' },
    ]);
    assert.equal(task!.callbackUrl, 'http://127.0.0.1:1/hook');
  } finally {
    await idle.close();
  }
});

test('文档里的 pipeline 示例对真实注册表有效（只校验和入队，不执行）', async (t) => {
  if (skipWithoutRedis(t)) return;
  const idle = await startEngine({ operations: [...registry], worker: false });
  try {
    const examples = [
      [
        { op: 'trim', params: { startTime: 5, duration: 10 } },
        { op: 'video.resize', params: { width: 720 } },
        {
          op: 'watermark',
          params: { position: 'bottom-right' },
          inputs: { image: `${files.base}/logo.png` },
        },
      ],
      [{ op: 'trim', params: { startTime: 0, duration: 30 } }, { op: 'video.hls' }],
      [
        { op: 'trim', params: { startTime: 0, duration: 60 } },
        { op: 'video.mix-audio', inputs: { audio: `${files.base}/in.txt` } },
        { op: 'video.compress', params: {} },
      ],
    ];
    for (const steps of examples) {
      const res = await postJson(`${idle.base}${PIPELINE}`, { url: `${files.base}/in.txt`, steps });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  } finally {
    await idle.close();
  }
});

test(
  '真实 ffmpeg：trim → video.resize → video.hls（注册表里的操作串联）',
  { skip: ffmpegSkip },
  async (t) => {
    if (skipWithoutRedis(t)) return;
    const ops = ['trim', 'video.resize', 'video.hls'].map((name) => getOperation(name)!);
    const real = await startEngine({ operations: ops });
    const dir = makeTempDir();
    try {
      const video = makeVideo(dir, 'in.mp4', { duration: 3 });
      const form = new FormData();
      form.append('file', fileBlob(fs.readFileSync(video), 'video/mp4'), 'in.mp4');
      form.append(
        'steps',
        JSON.stringify([
          { op: 'trim', params: { startTime: 0.5, duration: 1.5 } },
          { op: 'video.resize', params: { width: 256 } },
          { op: 'video.hls', params: { renditions: '144', segmentDuration: 2 } },
        ]),
      );
      const submit = await postForm(`${real.base}${PIPELINE}`, form);
      assert.equal(submit.status, 200, JSON.stringify(submit.body));
      const taskId = submit.body.data!.taskId as string;
      const done = await waitForTask(real.tasks, taskId, undefined, 60_000);
      assert.equal(done.status, 'completed', done.error);
      assert.ok(done.steps!.every((s) => s.status === 'completed'));
      assert.match(done.primaryUrl!, /master\.m3u8$/);
      const names = done.outputs!.map((o) => o.name);
      const rendition = names.find((n) => n.endsWith('.m3u8') && !n.endsWith('master.m3u8'))!;
      assert.ok(rendition, names.join(','));
      const media = await probeMedia(path.join(outputDir, rendition));
      assert.equal(media.video!.width, 192);
      assert.equal(media.video!.height, 144);
      assert.ok(media.audio, '音轨应保留');
      assert.ok(Math.abs(media.duration - 1.5) < 0.3, `时长 ${media.duration}`);
      assert.equal(fs.existsSync(path.join(uploadDir, taskId)), false);
      await waitForTask(real.tasks, taskId, hasStatus('completed'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await real.close();
    }
  },
);
