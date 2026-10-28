import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { urlFieldsOf } from '../../../../src/core/inputs';
import { stack, planStack } from '../../../../src/operations/geometry/stack';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeTempDir } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { expectRunError, frameRate, makeColorVideo, makeQuadVideo, near, pixelAt } from './helpers';

let dir = '';
let quad = '';
let lime = '';
let blue = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-geo-stack-');
  // 320x240、2 秒、25fps、带音轨
  quad = makeQuadVideo(dir, 'quad.mp4', { duration: 2, audio: true });
  // 160x120、1 秒、30fps、带音轨
  lime = makeColorVideo(dir, 'lime.mp4', {
    color: 'lime',
    size: '160x120',
    duration: 1,
    audio: true,
    rate: 30,
  });
  // 320x180、2 秒、无音轨
  blue = makeColorVideo(dir, 'blue.mp4', { color: 'blue', size: '320x180', duration: 2 });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('stack: 左右并排统一到最矮的高度，间隔填色，按最短时长', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    stack,
    { files: [quad, lime] },
    { gap: 10, gapColor: 'yellow' },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.video?.width, 330);
    assert.equal(info.video?.height, 120);
    assert.ok(Math.abs(info.duration - 1) < 0.15, `时长 ${info.duration}`);
    assert.equal(info.audio?.codec, 'aac');
    // 帧率统一为第 1 个视频的 25fps
    assert.equal(frameRate(out), '25/1');
    assert.ok(near(pixelAt(out, 0.5, 165, 60), 'yellow'), '间隔');
    assert.ok(near(pixelAt(out, 0.5, 5, 5), 'red'));
    assert.ok(near(pixelAt(out, 0.5, 250, 60), 'lime'));
    assert.deepEqual(result.data, {
      width: 330,
      height: 120,
      layout: 'horizontal',
      columns: 2,
      rows: 1,
      duration: (result.data as { duration: number }).duration,
    });
  } finally {
    await ctx.cleanup();
  }
});

test('stack: 上下排列，duration=longest 时短视频停在最后一帧', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    stack,
    { files: [quad, lime] },
    { layout: 'vertical', width: 160, duration: 'longest' },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.video?.width, 160);
    assert.equal(info.video?.height, 240);
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
    assert.ok(near(pixelAt(out, 1.6, 80, 180), 'lime'), '第 2 个视频结束后应停在最后一帧');
  } finally {
    await ctx.cleanup();
  }
});

test('stack: 宫格自动 2x2，空格和格内留白填色', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    stack,
    { files: [quad, lime, blue] },
    { layout: 'grid', gapColor: 'red' },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    // 格子取面积最小的输入 160x120
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.equal((result.data as { columns: number }).columns, 2);
    assert.equal((result.data as { rows: number }).rows, 2);
    assert.ok(near(pixelAt(out, 0.5, 240, 180), 'red'), '第 4 格为空');
    // 320x180 缩成 160x90 放进 160x120 的格子，上下各 15 像素留白
    assert.ok(near(pixelAt(out, 0.5, 80, 124), 'red'), '格内留白');
    assert.ok(near(pixelAt(out, 0.5, 80, 180), 'blue'));
    assert.ok(near(pixelAt(out, 0.5, 240, 60), 'lime'));
  } finally {
    await ctx.cleanup();
  }
});

test('stack: 音频 mix / none / 第 1 个视频无音轨', { skip: ffmpegSkip }, async () => {
  const mixed = await runOperation(
    stack,
    { files: [quad, lime, blue] },
    { layout: 'grid', audio: 'mix', duration: 'longest' },
  );
  try {
    const info = await probeMedia(mixed.result.files[0]);
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
  } finally {
    await mixed.ctx.cleanup();
  }

  const none = await runOperation(stack, { files: [quad, lime] }, { audio: 'none' });
  try {
    assert.equal((await probeMedia(none.result.files[0])).audio, undefined);
  } finally {
    await none.ctx.cleanup();
  }

  const firstSilent = await runOperation(stack, { files: [blue, quad] });
  try {
    assert.equal((await probeMedia(firstSilent.result.files[0])).audio, undefined);
    assert.ok(firstSilent.ctx.logs.some((l) => l.includes('第 1 个视频没有音轨')));
  } finally {
    await firstSilent.ctx.cleanup();
  }
});

test('stack: 拼接后超过尺寸上限时报错', { skip: ffmpegSkip }, async () => {
  await expectRunError(
    stack,
    { files: [quad, quad] },
    { height: 4320 },
    /拼接后的画面 11520x4320 超过上限 7680x4320.*请调小 height \/ width 或改用 grid 布局/,
  );
});

test('stack: 参数校验', () => {
  const two = { files: 2 };
  assert.deepEqual(paramErrors(stack, {}, two), []);
  assert.deepEqual(paramErrors(stack, {}, { files: 1 }), ['files 需要 2-9 个视频，当前 1 个']);
  assert.deepEqual(paramErrors(stack, { columns: 2 }, two), [
    'columns 只能和 layout=grid 一起使用',
  ]);
  assert.deepEqual(paramErrors(stack, { width: 100 }, two), [
    'horizontal 布局用 height 统一高度，不能指定 width',
  ]);
  assert.deepEqual(paramErrors(stack, { layout: 'vertical', height: 100 }, two), [
    'vertical 布局用 width 统一宽度，不能指定 height',
  ]);
  assert.deepEqual(paramErrors(stack, { layout: 'grid', width: 320, height: 180 }, two), []);
  assert.deepEqual(paramErrors(stack, { gap: 500 }, two), ['gap 必须是 0 到 200 之间的整数']);
  assert.match(paramErrors(stack, { layout: 'circle' }, two)[0], /layout 只能是/);
  assert.match(paramErrors(stack, { duration: 'avg' }, two)[0], /duration 只能是/);
});

test('stack: 宫格布局计算', () => {
  const s = (n: number) => Array.from({ length: n }, () => ({ width: 640, height: 360 }));
  const base = { layout: 'grid', gap: 0 } as const;
  const nine = planStack(s(9), base);
  assert.deepEqual([nine.columns, nine.rows, nine.width, nine.height], [3, 3, 1920, 1080]);
  assert.equal(nine.needsFill, false);
  const five = planStack(s(5), { ...base, gap: 4 });
  assert.deepEqual([five.columns, five.rows, five.width, five.height], [3, 2, 1928, 724]);
  assert.equal(five.needsFill, true);
  assert.deepEqual(five.cells[4], {
    width: 640,
    height: 360,
    x: 644,
    y: 364,
    cellWidth: 640,
    cellHeight: 360,
  });
  const oneRow = planStack(s(4), { ...base, columns: 4, width: 320 });
  assert.deepEqual([oneRow.columns, oneRow.rows, oneRow.width, oneRow.height], [4, 1, 1280, 180]);
  const vertical = planStack(
    [
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
    ],
    { layout: 'vertical', gap: 0 },
  );
  assert.deepEqual(
    vertical.cells.map((c) => [c.width, c.height, c.y]),
    [
      [1080, 608, 0],
      [1080, 1920, 608],
    ],
  );
  // 奇数间隔向上取偶数，总宽高保持偶数
  const odd = planStack(s(3), { layout: 'horizontal', gap: 5 });
  assert.equal(odd.width, 640 * 3 + 6 * 2);
  assert.deepEqual(
    odd.cells.map((c) => c.x),
    [0, 646, 1292],
  );
  assert.equal(planStack(s(5), { ...base, gap: 1 }).height, 360 * 2 + 2);
});

test('stack: 奇数 gap 也能编码（输出宽高为偶数）', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    stack,
    { files: [lime, lime] },
    { gap: '5', gapColor: 'white' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 160 + 6 + 160);
    assert.equal(info.video?.height, 120);
    assert.ok(near(pixelAt(result.files[0], 0.5, 163, 60), 'white'), '间隔');
  } finally {
    await ctx.cleanup();
  }
});

test('stack: URL 方式接受 filesUrls 和 urls 两个字段', () => {
  assert.deepEqual(urlFieldsOf(stack.inputs[0]), ['filesUrls', 'urls']);
});
