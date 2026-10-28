import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rotate, planRotation, rotatedCanvas } from '../../../../src/operations/geometry/rotate';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  displayRotation,
  expectRunError,
  makeQuadVideo,
  makeWebm,
  near,
  pixelAt,
  type Rgb,
  withDisplayRotation,
} from './helpers';

let dir = '';
let quad = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-geo-rotate-');
  // 左上红、右上绿、左下蓝、右下白，带音轨
  quad = makeQuadVideo(dir, 'quad.mp4', { audio: true });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

/** 四个角的颜色：左上、右上、左下、右下 */
async function corners(file: string): Promise<Rgb[]> {
  const info = await probeMedia(file);
  // 带显示矩阵时 probe 的宽高是存储尺寸，pixelAt 解码时已摆正，这里按显示尺寸取角
  const rot = Math.abs(Math.round((await displayRotation(file)) ?? 0) / 90) % 2 === 1;
  const w = (rot ? info.video?.height : info.video?.width) ?? 0;
  const h = (rot ? info.video?.width : info.video?.height) ?? 0;
  return [
    pixelAt(file, 0.5, 10, 10),
    pixelAt(file, 0.5, w - 10, 10),
    pixelAt(file, 0.5, 10, h - 10),
    pixelAt(file, 0.5, w - 10, h - 10),
  ];
}

function assertCorners(actual: Rgb[], expected: string[]) {
  expected.forEach((color, i) => {
    assert.ok(near(actual[i], color as 'red'), `第 ${i + 1} 个角应为 ${color}，实际 ${actual[i]}`);
  });
}

test('rotate: angle=90 顺时针旋转，宽高互换，音轨复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(rotate, { file: [quad] }, { angle: '90' });
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 240);
    assert.equal(info.video?.height, 320);
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 1) < 0.15, `时长 ${info.duration}`);
    // 顺时针 90 度：原左下（蓝）到左上，原左上（红）到右上
    assertCorners(await corners(result.files[0]), ['blue', 'red', 'white', 'lime']);
    assert.equal(await displayRotation(result.files[0]), undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('rotate: angle=180、270 和 flip', { skip: ffmpegSkip }, async () => {
  const cases: [Record<string, unknown>, string[]][] = [
    [{ angle: 180 }, ['white', 'blue', 'lime', 'red']],
    [{ angle: 270 }, ['lime', 'white', 'red', 'blue']],
    [{ flip: 'horizontal' }, ['lime', 'red', 'white', 'blue']],
    [{ flip: 'vertical' }, ['blue', 'white', 'red', 'lime']],
    // 先顺时针 90 度（蓝 红 / 白 绿），再左右镜像
    [{ angle: 90, flip: 'horizontal' }, ['red', 'blue', 'lime', 'white']],
    [{ degrees: -90 }, ['lime', 'white', 'red', 'blue']],
  ];
  for (const [params, expected] of cases) {
    const { result, ctx } = await runOperation(rotate, { file: [quad] }, params);
    try {
      assertCorners(await corners(result.files[0]), expected);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('rotate: 任意角度扩大画布并用 fillColor 填充', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    rotate,
    { file: [quad] },
    { degrees: 45, fillColor: 'yellow' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    // 外接矩形 (320+240)·cos45° ≈ 395.98，向上取偶数
    assert.equal(info.video?.width, 396);
    assert.equal(info.video?.height, 396);
    assert.ok(near(pixelAt(result.files[0], 0.5, 3, 3), 'yellow'));
    // 中心仍是画面内容（四色交界附近），不是填充色
    assert.ok(!near(pixelAt(result.files[0], 0.5, 198, 150), 'yellow'));
  } finally {
    await ctx.cleanup();
  }
});

test('rotate: expand=false 保持原尺寸', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    rotate,
    { file: [quad] },
    { degrees: '30', expand: 'false' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'rotate: 带旋转元数据的视频按显示方向旋转，输出不再带显示矩阵',
  { skip: ffmpegSkip },
  async () => {
    // 显示矩阵逆时针 90 度：播放器里看到的是 240x320，左上角为绿
    const rotated = withDisplayRotation(quad, path.join(dir, 'phone.mp4'), 90);
    assertCorners(await corners(rotated), ['lime', 'white', 'red', 'blue']);
    const { result, ctx } = await runOperation(rotate, { file: [rotated] }, { angle: 90 });
    try {
      const info = await probeMedia(result.files[0]);
      assert.equal(info.video?.width, 320);
      assert.equal(info.video?.height, 240);
      assert.equal(await displayRotation(result.files[0]), undefined);
      assertCorners(await corners(result.files[0]), ['red', 'lime', 'blue', 'white']);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('rotate: lossless 只改显示矩阵，不重新编码', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    rotate,
    { file: [quad] },
    { angle: 90, lossless: true },
  );
  try {
    const info = await probeMedia(result.files[0]);
    // 存储尺寸不变，显示矩阵为顺时针 90 度（ffprobe 显示 -90）
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.equal(await displayRotation(result.files[0]), -90);
    assert.deepEqual(result.data, { lossless: true, displayRotation: -90 });
    // 播放效果和重新编码的结果一致
    assertCorners(await corners(result.files[0]), ['blue', 'red', 'white', 'lime']);
  } finally {
    await ctx.cleanup();
  }
});

test('rotate: lossless 和原有旋转叠加、支持镜像', { skip: ffmpegSkip }, async () => {
  const rotated = withDisplayRotation(quad, path.join(dir, 'phone2.mp4'), 90);
  const { result, ctx } = await runOperation(
    rotate,
    { file: [rotated] },
    { angle: 90, lossless: true },
  );
  try {
    // 逆时针 90 + 顺时针 90 = 0：摆回原方向
    assert.equal((result.data as { displayRotation: number }).displayRotation, 0);
    assertCorners(await corners(result.files[0]), ['red', 'lime', 'blue', 'white']);
  } finally {
    await ctx.cleanup();
  }
  const flipped = await runOperation(rotate, { file: [quad] }, { flip: 'both', lossless: true });
  try {
    assertCorners(await corners(flipped.result.files[0]), ['white', 'blue', 'lime', 'red']);
  } finally {
    await flipped.ctx.cleanup();
  }
});

test('rotate: lossless 可无损复制 VP9，不能放进 mp4 的编码报错', { skip: ffmpegSkip }, async () => {
  const webm = makeWebm(dir, 'in.webm');
  // VP9 可以无损复制进 mp4，opus 转 AAC
  const { result, ctx } = await runOperation(
    rotate,
    { file: [webm] },
    { angle: 180, lossless: true },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.codec, 'vp9');
    assert.equal(info.audio?.codec, 'aac');
  } finally {
    await ctx.cleanup();
  }
  const mjpeg = path.join(dir, 'mjpeg.avi');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25:duration=1',
    '-c:v',
    'mjpeg',
    mjpeg,
  ]);
  await expectRunError(
    rotate,
    { file: [mjpeg] },
    { angle: 90, lossless: true },
    /lossless 模式要求画面编码为 H\.264.*当前是 mjpeg/,
  );
});

test('rotate: 重新编码的输出超过尺寸上限时报错', { skip: ffmpegSkip }, async () => {
  // 7700x16 的超宽画面（MJPEG 编码几乎不花时间），90 度旋转后长边 7700 超过 7680
  const huge = path.join(dir, 'huge.avi');
  generate(['-f', 'lavfi', '-i', 'color=black:s=7700x16:d=0.08:r=25', '-c:v', 'mjpeg', huge]);
  await expectRunError(
    rotate,
    { file: [huge] },
    { angle: 90 },
    /旋转后的画面 16x7700 超过上限 7680x4320/,
  );
});

test('rotate: 纯音频输入报错', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'a.wav');
  await expectRunError(rotate, { file: [audio] }, { angle: 90 }, /输入文件不包含视频画面/);
});

test('rotate: 参数校验', () => {
  assert.deepEqual(paramErrors(rotate, {}), [
    '请提供 angle（90 / 180 / 270）、degrees 或 flip 中的至少一个',
  ]);
  assert.deepEqual(paramErrors(rotate, { angle: 90, degrees: 10 }), [
    'angle 和 degrees 不能同时使用',
  ]);
  assert.deepEqual(paramErrors(rotate, { angle: 45 }), ['angle 只能是 90 / 180 / 270']);
  assert.deepEqual(paramErrors(rotate, { angle: 90 }), []);
  assert.deepEqual(paramErrors(rotate, { angle: '270' }), []);
  assert.deepEqual(paramErrors(rotate, { degrees: 400 }), [
    'degrees 必须是 -360 到 360 之间的数字',
  ]);
  assert.deepEqual(paramErrors(rotate, { degrees: 45, lossless: true }), [
    'lossless 只支持 90 度倍数的旋转，任意角度请去掉 lossless 重新编码',
  ]);
  assert.deepEqual(paramErrors(rotate, { degrees: -270, lossless: 'true' }), []);
  assert.match(paramErrors(rotate, { flip: 'diagonal' })[0], /flip 只能是/);
  assert.match(
    paramErrors(rotate, { degrees: 10, fillColor: "black'[out]" })[0],
    /fillColor 必须是颜色名/,
  );
});

test('rotate: 角度换算和外接矩形', () => {
  const base = { flip: 'none', fillColor: 'black', expand: true, lossless: false } as const;
  assert.equal(planRotation({ ...base, degrees: 90 }).quarterTurns, 1);
  assert.equal(planRotation({ ...base, degrees: -90 }).quarterTurns, 3);
  assert.equal(planRotation({ ...base, degrees: 360 }).quarterTurns, 0);
  assert.equal(planRotation({ ...base, degrees: 12.5 }).degrees, 12.5);
  assert.deepEqual(rotatedCanvas(1920, 1080, 90, true), { width: 1080, height: 1920 });
  assert.deepEqual(rotatedCanvas(1920, 1080, 30, false), { width: 1920, height: 1080 });
});
