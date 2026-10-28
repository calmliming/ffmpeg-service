import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { color, colorFilters } from '../../../../src/operations/effects/color';
import { probeMedia } from '../../../../src/utils/media-probe';
import { frameStats } from './fixtures';

let dir = '';
let video = '';
let gray = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-color-');
  video = makeVideo(dir, 'in.mp4', { size: '320x240', duration: 2 });
  gray = path.join(dir, 'gray.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x808080:size=320x240:rate=25:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    gray,
  ]);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('colorFilters：先预设后微调，默认值不产生滤镜', () => {
  const base = { preset: 'none' as const };
  assert.deepEqual(colorFilters(base), []);
  assert.deepEqual(colorFilters({ ...base, brightness: 0, contrast: 1, hue: 0 }), []);
  assert.deepEqual(colorFilters({ preset: 'grayscale', brightness: 0.1, gamma: 1.5, hue: 30 }), [
    'hue=s=0',
    'eq=brightness=0.1:gamma=1.5',
    'hue=h=30',
  ]);
});

test('color：grayscale 预设输出黑白画面，音轨保留', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(color, { file: [video] }, { preset: 'GrayScale' });
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.video?.width, 320);
    assert.ok(Math.abs(info.duration - 2) < 0.15);
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(frameStats(video).SATAVG > 20);
    assert.ok(frameStats(out).SATAVG < 1, `SATAVG ${frameStats(out).SATAVG}`);
  } finally {
    await ctx.cleanup();
  }
});

test('color：亮度 / 对比度与时间段，时间段外画面不变', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    color,
    { file: [video] },
    { brightness: '0.3', contrast: '1.2', startTime: '1' },
  );
  try {
    const out = result.files[0];
    const before = frameStats(video, 5).YAVG;
    // 第 5 帧（0.2 秒）在时间段外，第 40 帧（1.6 秒）在时间段内
    assert.ok(Math.abs(frameStats(out, 5).YAVG - before) < 2);
    assert.ok(frameStats(out, 40).YAVG > frameStats(video, 40).YAVG + 30);
  } finally {
    await ctx.cleanup();
  }
});

test('color：warm / cool 预设分别偏红和偏蓝', { skip: ffmpegSkip }, async () => {
  const src = frameStats(gray, 5);
  const warm = await runOperation(color, { file: [gray] }, { preset: 'warm' });
  const cool = await runOperation(color, { file: [gray] }, { preset: 'cool' });
  try {
    const w = frameStats(warm.result.files[0], 5);
    const c = frameStats(cool.result.files[0], 5);
    // VAVG 是 Cr（偏红），UAVG 是 Cb（偏蓝）；无音轨输入不应产生音轨
    assert.ok(w.VAVG > src.VAVG + 3 && w.UAVG < src.UAVG - 3, JSON.stringify(w));
    assert.ok(c.VAVG < src.VAVG - 3 && c.UAVG > src.UAVG + 3, JSON.stringify(c));
    assert.equal((await probeMedia(warm.result.files[0])).audio, undefined);
  } finally {
    await warm.ctx.cleanup();
    await cool.ctx.cleanup();
  }
});

test('color：所有预设都能跑通', { skip: ffmpegSkip }, async () => {
  for (const preset of [
    'sepia',
    'negate',
    'vintage',
    'vivid',
    'crossprocess',
    'lighter',
    'darker',
    'contrast',
  ]) {
    const { result, ctx } = await runOperation(color, { file: [gray] }, { preset, endTime: 0.5 });
    try {
      assert.equal((await probeMedia(result.files[0])).video?.width, 320, preset);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('color：纯音频输入返回明确错误', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'a.mp3', { duration: 1 });
  await assert.rejects(
    runOperation(color, { file: [audio] }, { preset: 'sepia' }),
    /输入文件不包含视频画面/,
  );
});

test('color：参数校验', () => {
  assert.match(paramErrors(color, {})[0], /至少需要一项调整/);
  assert.match(paramErrors(color, { brightness: '0', saturation: 1 })[0], /至少需要一项调整/);
  assert.deepEqual(paramErrors(color, { brightness: 2 }), ['brightness 必须是 -1 到 1 之间的数字']);
  assert.deepEqual(paramErrors(color, { gamma: 0 }), ['gamma 必须是 0.1 到 10 之间的数字']);
  assert.deepEqual(paramErrors(color, { hue: 200 }), ['hue 必须是 -180 到 180 之间的数字']);
  assert.match(paramErrors(color, { preset: 'lomo' })[0], /^preset 只能是 none \/ grayscale/);
  assert.deepEqual(paramErrors(color, { preset: 'sepia', startTime: 2, endTime: 1 }), [
    'endTime 必须大于 startTime',
  ]);
});
