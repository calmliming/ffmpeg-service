import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import IORedis from 'ioredis';
import { z } from 'zod';
import {
  TEST_REDIS_URL,
  cleanupRoot,
  fileBlob,
  listOutputs,
  outputDir,
  postForm,
  redisAvailable,
  startEngine,
  uploadDir,
  waitFor,
  waitForEmptyDir,
  waitForTask,
} from './harness';
import { isInside } from '../../../src/core/inputs';
import { defineOperation } from '../../../src/operations/types';
import { createTaskWorker, publishOutputs } from '../../../src/services/queue.service';

let redisUp = false;

before(async () => {
  redisUp = await redisAvailable();
});

after(() => {
  cleanupRoot();
});

function skipWithoutRedis(t: { skip(message?: string): void }): boolean {
  if (redisUp) return false;
  t.skip('Redis 不可用');
  return true;
}

/** 重新执行时的 test-crash：正常写完一个文件和一个目录产物 */
const finishOp = defineOperation({
  name: 'test-crash',
  route: '/api/test/crash',
  title: '测试崩溃',
  description: '第二次执行正常完成',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '任意输入' }],
  params: z.object({}),
  async run(ctx) {
    const file = ctx.outputPath('mp4');
    await fs.promises.writeFile(file, 'final');
    const dir = await ctx.outputDir();
    const playlist = path.join(dir, 'index.m3u8');
    const segment = path.join(dir, 'seg0.ts');
    await fs.promises.writeFile(playlist, '#EXTM3U\n');
    await fs.promises.writeFile(segment, 'segment');
    ctx.progress(0.2);
    ctx.progress(0.9);
    return { files: [file, playlist, segment], primary: file };
  },
});

interface Ready {
  file: string;
  dir: string;
  workDir: string;
}

test('执行中进程被杀：半截产物只在 uploads/<taskId> 里、下载不到；重新执行后输出目录只有新产物，进度不倒退', async (t) => {
  if (skipWithoutRedis(t)) return;
  const engine = await startEngine({ operations: [finishOp], worker: false });
  const before = listOutputs();
  const form = new FormData();
  form.append('file', fileBlob('input', 'video/mp4'), 'in.mp4');
  const submit = await postForm(`${engine.base}/api/test/crash`, form);
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const taskId = submit.body.data!.taskId as string;

  // 子进程里的 Worker 接手这个 job，写了一半产物后挂起
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(__dirname, 'crash-worker.ts')],
    {
      env: {
        ...process.env,
        CRASH_UPLOAD_DIR: uploadDir,
        CRASH_OUTPUT_DIR: outputDir,
        CRASH_REDIS_URL: TEST_REDIS_URL,
        CRASH_PREFIX: engine.prefix,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));
  let recovery: ReturnType<typeof createTaskWorker> | undefined;
  const recoveryRedis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  try {
    await waitFor(() => /READY /.test(stdout), 20_000).catch(() => {
      throw new Error(`子进程没有开始执行任务\nstdout: ${stdout}\nstderr: ${stderr}`);
    });
    const ready = JSON.parse(/READY (.+)/.exec(stdout)![1]) as Ready;
    await waitForTask(engine.tasks, taskId, (task) => task.progress >= 38);

    // 写到一半的产物在任务的 workDir 里，不在输出目录，也下载不到
    const workDir = path.join(uploadDir, taskId);
    assert.ok(isInside(workDir, ready.file), ready.file);
    assert.ok(isInside(workDir, ready.dir), ready.dir);
    assert.deepEqual(listOutputs(), before);
    const leaked = await fetch(`${engine.base}/api/files/${path.basename(ready.file)}`);
    assert.equal(leaked.status, 404);
    const progressAtCrash = (await engine.tasks.get(taskId))!.progress;

    child.kill('SIGKILL');
    await once(child, 'exit');

    // 另一个 Worker 的卡死检测把 job 放回队列并重新执行
    const seen: number[] = [];
    const off = engine.tasks.onProgress(taskId, (task) => seen.push(task.progress));
    recovery = createTaskWorker({
      operations: [finishOp],
      tasks: engine.tasks,
      connection: recoveryRedis,
      prefix: engine.prefix,
      concurrency: 1,
      stalled: { stalledInterval: 300 },
    });
    const done = await waitForTask(engine.tasks, taskId, undefined, 20_000);
    off();
    assert.equal(done.status, 'completed', done.error);

    // 第一次执行的半截产物没有了，输出目录里只有这次的产物（子目录结构保留）
    assert.equal(fs.existsSync(ready.file), false);
    assert.equal(fs.existsSync(ready.dir), false);
    const added = listOutputs().filter((name) => !before.includes(name));
    assert.deepEqual(added.sort(), done.outputs!.map((o) => o.name).sort());
    assert.equal(done.outputs!.length, 3);
    assert.match(done.outputs![1].name, /^[0-9a-f-]{36}\/index\.m3u8$/);
    const primary = await fetch(`${engine.base}${done.primaryUrl}`);
    assert.equal(await primary.text(), 'final');
    const playlist = await fetch(`${engine.base}/api/files/${done.outputs![1].name}`);
    assert.equal(await playlist.text(), '#EXTM3U\n');
    // 旧字段 output 是相对路径
    assert.equal(done.output, done.outputs!.map((o) => o.name).join(','));

    // 进度只增不减：重新执行时不会从 0 开始
    assert.ok(seen.length > 0);
    for (const value of seen) assert.ok(value >= progressAtCrash, `${seen.join(',')}`);
    await waitFor(() => !fs.existsSync(workDir), 3000);
    assert.deepEqual(await waitForEmptyDir(uploadDir), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await recovery?.close();
    recoveryRedis.disconnect();
    await engine.close();
  }
});

test('跨文件系统（EXDEV）时复制到输出目录里的隐藏目录再改名，产物完整，临时目录被清掉', async (t) => {
  if (skipWithoutRedis(t)) return;
  const engine = await startEngine({ operations: [finishOp] });
  const rename = fs.promises.rename;
  let crossDevice = 0;
  // 从 uploads（暂存目录）改名到输出目录时报 EXDEV，像 Docker 里容器层和卷之间那样
  fs.promises.rename = (async (src: fs.PathLike, dest: fs.PathLike) => {
    if (isInside(uploadDir, String(src)) && isInside(outputDir, String(dest))) {
      crossDevice++;
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    }
    return rename(src, dest);
  }) as typeof fs.promises.rename;
  try {
    const form = new FormData();
    form.append('file', fileBlob('input', 'video/mp4'), 'in.mp4');
    const submit = await postForm(`${engine.base}/api/test/crash`, form);
    const done = await waitForTask(engine.tasks, submit.body.data!.taskId as string);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(crossDevice, 2, '文件和目录各改名失败一次');
    for (const output of done.outputs!) {
      assert.ok(fs.existsSync(path.join(outputDir, output.name)), output.name);
    }
    const playlist = await fetch(`${engine.base}/api/files/${done.outputs![1].name}`);
    assert.equal(await playlist.text(), '#EXTM3U\n');
    const partial = path.join(outputDir, '.partial');
    assert.deepEqual(fs.existsSync(partial) ? fs.readdirSync(partial) : [], []);
    assert.equal(
      listOutputs().some((name) => name.startsWith('.partial')),
      false,
    );
  } finally {
    fs.promises.rename = rename;
    await engine.close();
  }
});

test('publishOutputs：中途失败时已移过去的产物被删除，错误信息说明是保存产物失败', async () => {
  const staging = fs.mkdtempSync(path.join(uploadDir, 'staging-'));
  const target = fs.mkdtempSync(path.join(uploadDir, 'target-'));
  const a = path.join(staging, 'a.mp4');
  const dir = path.join(staging, 'd');
  fs.writeFileSync(a, 'a');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'x.ts'), 'x');
  const rename = fs.promises.rename;
  fs.promises.rename = (async (src: fs.PathLike, dest: fs.PathLike) => {
    if (String(src) === dir) {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return rename(src, dest);
  }) as typeof fs.promises.rename;
  try {
    await assert.rejects(
      publishOutputs([a, path.join(dir, 'x.ts')], staging, target, 'task-1'),
      /保存产物到输出目录失败/,
    );
    assert.equal(fs.existsSync(path.join(target, 'a.mp4')), false);
    assert.equal(fs.existsSync(path.join(target, 'd')), false);
  } finally {
    fs.promises.rename = rename;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
