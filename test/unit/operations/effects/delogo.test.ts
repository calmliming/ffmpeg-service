import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ffmpegSkip, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { clampDelogo, delogo } from '../../../../src/operations/effects/delogo';
import { probeMedia } from '../../../../src/utils/media-probe';
import { psnr } from './fixtures';

let dir = '';
let video = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-delogo-');
  video = makeVideo(dir, 'in.mp4', { size: '320x240', duration: 2 });
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('clampDelogo 把贴边的区域收进 1 像素', () => {
  assert.deepEqual(clampDelogo({ x: 0, y: 0, width: 320, height: 50 }, 320, 240, 'r'), {
    x: 1,
    y: 1,
    w: 318,
    h: 49,
  });
  assert.deepEqual(clampDelogo({ x: 300, y: 200, width: 100, height: 100 }, 320, 240, 'r'), {
    x: 300,
    y: 200,
    w: 19,
    h: 39,
  });
  assert.throws(() => clampDelogo({ x: 500, y: 0, width: 10, height: 10 }, 320, 240, '水印区域'), {
    message: /水印区域在画面（320x240）之外/,
  });
});

test('delogo：贴着左上角的水印区域会被收进画面并成功处理', { skip: ffmpegSkip }, async () => {
  // testsrc2 左上角有时间码文字，正好当作水印
  const { result, ctx } = await runOperation(
    delogo,
    { file: [video] },
    { x: '0', y: '0', width: '110', height: '45' },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.ok(Math.abs(info.duration - 2) < 0.15);
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(psnr(video, out, '100:40:4:4') < 25, '水印区域应被抹掉');
    assert.ok(psnr(video, out, '160:120:160:120') > 35, '其他区域保持原样');
  } finally {
    await ctx.cleanup();
  }
});

test('delogo：多个区域各自的时间段 + show 调试框 + 百分比坐标', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    delogo,
    { file: [video] },
    {
      regions: JSON.stringify([
        { x: 0, y: 0, width: 30, height: 20, endTime: 1 },
        { x: 70, y: 70, width: 30, height: 30, startTime: 1 },
      ]),
      unit: 'percent',
      show: 'true',
    },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.ok(Math.abs(info.duration - 2) < 0.15);
  } finally {
    await ctx.cleanup();
  }
});

test('delogo：区域在画面外、开始时间超出时长返回明确错误', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(delogo, { file: [video] }, { x: 400, y: 10, width: 50, height: 20 }),
    /水印区域在画面（320x240）之外/,
  );
  await assert.rejects(
    runOperation(
      delogo,
      { file: [video] },
      { regions: [{ x: 10, y: 10, width: 50, height: 20, startTime: 9 }] },
    ),
    /regions 第 1 个区域的开始时间（9 秒）超出视频时长/,
  );
});

test('delogo：参数校验', () => {
  assert.deepEqual(paramErrors(delogo, { x: 1, y: 1 }), [
    '需要同时提供 x、y、width、height，或者用 regions 指定区域',
  ]);
  assert.deepEqual(paramErrors(delogo, {}), [
    '需要同时提供 x、y、width、height，或者用 regions 指定区域',
  ]);
  assert.deepEqual(
    paramErrors(delogo, { x: 1, y: 1, width: 10, height: 10, regions: '1,1,10,10' }),
    ['regions 和 x / y / width / height 只能二选一'],
  );
  assert.deepEqual(paramErrors(delogo, { x: -5, y: 1, width: 10, height: 10 }), [
    'x 必须是 0 到 100000 之间的数字',
  ]);
  assert.deepEqual(paramErrors(delogo, { x: 1, y: 1, width: 10, height: 10, show: 'maybe' }), [
    'show 必须是布尔值（true / false）',
  ]);
  assert.deepEqual(paramErrors(delogo, { x: 1, y: 1, width: 10, height: 10 }), []);
});
