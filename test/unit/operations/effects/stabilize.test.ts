import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, generate, makeTempDir } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import { normalizeRawParams } from '../../../../src/core/params';
import { stabilize } from '../../../../src/operations/effects/stabilize';
import { probeMedia } from '../../../../src/utils/media-probe';
import { frameMotion } from './fixtures';

let dir = '';
let shaky = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-stabilize-');
  shaky = path.join(dir, 'shaky.mp4');
  // 静止的测试图案，按逐帧抖动的位置裁出 320x240：画面里唯一的运动就是模拟的手持抖动
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=400x300:rate=25:duration=0.04',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-vf',
    'loop=loop=49:size=1,setpts=N/25/TB,crop=320:240:40+30*sin(n*1.7):30+20*cos(n*2.3)',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    shaky,
  ]);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'stabilize：两遍处理，进度分段递增，阶段从 analyzing 切到 processing',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(stabilize, { file: [shaky] }, { smoothing: '15' });
    try {
      const out = result.files[0];
      const info = await probeMedia(out);
      assert.equal(info.video?.width, 320);
      assert.equal(info.video?.height, 240);
      assert.ok(Math.abs(info.duration - 2) < 0.15);
      assert.equal(info.audio?.codec, 'aac');
      // 第一遍的运动数据写在 workDir 里
      assert.ok(fs.existsSync(path.join(ctx.workDir, 'transforms.trf')));
      const before = frameMotion(shaky);
      const after = frameMotion(out);
      assert.ok(after < before * 0.8, `防抖前帧差 ${before}，防抖后 ${after}`);

      const fractions = ctx.progressCalls.map((c) => c.fraction);
      for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1]);
      assert.equal(fractions.at(-1), 1);
      const phases = ctx.progressCalls.filter((c) => c.extra?.phase).map((c) => c.extra?.phase);
      assert.deepEqual(phases, ['analyzing', 'processing']);
      const switchAt = ctx.progressCalls.findIndex((c) => c.extra?.phase === 'processing');
      assert.equal(ctx.progressCalls[switchAt].fraction, 0.5);
      assert.ok(ctx.progressCalls.slice(0, switchAt).every((c) => c.fraction <= 0.5));
    } finally {
      await ctx.cleanup();
    }
  },
);

test(
  'stabilize：三脚架模式 + 关闭自动缩放 + keep 填充 + 无锐化',
  { skip: ffmpegSkip },
  async () => {
    const silent = path.join(dir, 'silent.mp4');
    generate(['-i', shaky, '-an', '-c:v', 'copy', silent]);
    const { result, ctx } = await runOperation(
      stabilize,
      { file: [silent] },
      { tripod: true, autoZoom: false, crop: 'keep', zoom: 5, sharpen: false },
    );
    try {
      const info = await probeMedia(result.files[0]);
      assert.equal(info.video?.width, 320);
      assert.equal(info.audio, undefined);
      // 三脚架模式把镜头锁死，静止图案的帧差应大幅下降
      assert.ok(frameMotion(result.files[0]) < frameMotion(silent) * 0.6);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('stabilize：取消任务会立即终止 ffmpeg', { skip: ffmpegSkip }, async () => {
  const long = path.join(dir, 'long.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25:duration=30',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    long,
  ]);
  const controller = new AbortController();
  const ctx = createTestContext({ file: [long] }, { signal: controller.signal });
  try {
    const params = stabilize.params.parse(normalizeRawParams({}));
    const started = Date.now();
    const running = stabilize.run(ctx, params);
    setTimeout(() => controller.abort(new Error('任务已取消')), 300);
    await assert.rejects(running, /任务已取消/);
    assert.ok(Date.now() - started < 5000, '取消后应很快返回');
  } finally {
    await ctx.cleanup();
  }
});

test('stabilize：参数校验', () => {
  assert.deepEqual(paramErrors(stabilize, { smoothing: 0 }), [
    'smoothing 必须是 1 到 100 之间的整数',
  ]);
  assert.deepEqual(paramErrors(stabilize, { zoom: 25 }), ['zoom 必须是 0 到 20 之间的数字']);
  assert.deepEqual(paramErrors(stabilize, { crop: 'white' }), ['crop 只能是 black / keep']);
  assert.deepEqual(paramErrors(stabilize, { shakiness: 11 }), [
    'shakiness 必须是 1 到 10 之间的整数',
  ]);
  assert.deepEqual(paramErrors(stabilize, {}), []);
});
