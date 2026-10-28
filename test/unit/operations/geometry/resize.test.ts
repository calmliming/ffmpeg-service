import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resize, planResize } from '../../../../src/operations/geometry/resize';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { makeQuadVideo, makeWebm, near, pixelAt } from './helpers';

let dir = '';
let video = '';
let silent = '';
let quad = '';
let webm = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-geo-resize-');
  video = makeVideo(dir, 'in.mp4');
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
  webm = makeWebm(dir, 'in.webm');
  quad = makeQuadVideo(dir, 'quad.mp4');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

async function sizeOf(file: string) {
  const info = await probeMedia(file);
  return { width: info.video?.width, height: info.video?.height, info };
}

test('resize: 只给 width 时等比缩放，音轨直接复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(resize, { file: [video] }, { width: '160' });
  try {
    const { width, height, info } = await sizeOf(result.files[0]);
    assert.deepEqual({ width, height }, { width: 160, height: 120 });
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
    assert.deepEqual(result.data, { width: 160, height: 120 });
  } finally {
    await ctx.cleanup();
  }
});

test('resize: fit 模式等比缩放后用 padColor 补边', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    resize,
    { file: [quad] },
    { width: 200, height: 200, padColor: 'yellow' },
  );
  try {
    const { width, height, info } = await sizeOf(result.files[0]);
    assert.deepEqual({ width, height }, { width: 200, height: 200 });
    assert.equal(info.audio, undefined);
    // 320x240 缩到 200x150，上下各补 25 像素
    assert.ok(near(pixelAt(result.files[0], 0.5, 100, 5), 'yellow'));
    assert.ok(near(pixelAt(result.files[0], 0.5, 10, 40), 'red'));
    assert.ok(near(pixelAt(result.files[0], 0.5, 190, 160), 'white'));
  } finally {
    await ctx.cleanup();
  }
});

test('resize: fill 模式铺满后居中裁掉多余部分', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    resize,
    { file: [quad] },
    { width: 200, height: 200, mode: 'fill' },
  );
  try {
    const { width, height } = await sizeOf(result.files[0]);
    assert.deepEqual({ width, height }, { width: 200, height: 200 });
    // 266x200 居中裁成 200x200，四角仍是四个色块，没有补边
    assert.ok(near(pixelAt(result.files[0], 0.5, 2, 2), 'red'));
    assert.ok(near(pixelAt(result.files[0], 0.5, 197, 197), 'white'));
  } finally {
    await ctx.cleanup();
  }
});

test('resize: stretch 拉伸到精确尺寸，奇数取偶数', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    resize,
    { file: [video] },
    { width: 101, height: 301, mode: 'stretch', algorithm: 'lanczos' },
  );
  try {
    const { width, height } = await sizeOf(result.files[0]);
    assert.deepEqual({ width, height }, { width: 100, height: 300 });
  } finally {
    await ctx.cleanup();
  }
});

test('resize: scale 倍数缩放，无音轨输入', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    resize,
    { file: [silent] },
    { scale: 0.5, algorithm: 'neighbor' },
  );
  try {
    const { width, height, info } = await sizeOf(result.files[0]);
    assert.deepEqual({ width, height }, { width: 160, height: 120 });
    assert.equal(info.audio, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('resize: VP9 / Opus 的 webm 输入转成 H.264 / AAC mp4', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(resize, { file: [webm] }, { height: 120 });
  try {
    const { width, height, info } = await sizeOf(result.files[0]);
    assert.deepEqual({ width, height }, { width: 160, height: 120 });
    assert.equal(info.video?.codec, 'h264');
    // opus 不直接复制进 mp4，转成 AAC 保证兼容
    assert.equal(info.audio?.codec, 'aac');
  } finally {
    await ctx.cleanup();
  }
});

test('resize: 参数校验', () => {
  assert.deepEqual(paramErrors(resize, {}), ['请提供 width、height 或 scale 中的至少一个']);
  assert.deepEqual(paramErrors(resize, { scale: 2, width: 100 }), [
    'scale 不能和 width / height 同时使用',
  ]);
  assert.deepEqual(paramErrors(resize, { width: 9000 }), ['width 必须是 2 到 7680 之间的整数']);
  assert.deepEqual(paramErrors(resize, { width: 7680, height: 7680 }), [
    '输出尺寸 7680x7680 超过上限 7680x4320（竖屏 4320x7680）',
  ]);
  assert.deepEqual(paramErrors(resize, { width: 4320, height: 7680 }), []);
  assert.match(paramErrors(resize, { width: 100, height: 100, mode: 'zoom' })[0], /mode 只能是/);
  assert.match(
    paramErrors(resize, { width: 100, height: 100, padColor: 'red;drawtext' })[0],
    /padColor 必须是颜色名/,
  );
  assert.deepEqual(paramErrors(resize, { scale: 0 }), ['scale 必须是 0.01 到 10 之间的数字']);
});

test('resize: 尺寸计算与上限', () => {
  const base = { mode: 'fit', padColor: 'black', algorithm: 'bicubic' } as const;
  assert.deepEqual(planResize({ ...base, height: 720 }, 1920, 1080).width, 1280);
  // 单边计算出的另一边取偶数
  assert.deepEqual(planResize({ ...base, width: 640 }, 1918, 1080).height, 360);
  assert.throws(
    () => planResize({ ...base, scale: 10 }, 1000, 800),
    /缩放后的尺寸 10000x8000 超过上限/,
  );
  assert.throws(() => planResize({ ...base, height: 4320 }, 4000, 1000), /超过上限/);
});
