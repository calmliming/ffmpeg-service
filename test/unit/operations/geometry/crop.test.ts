import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crop, computeCropRect, aspectCropSize } from '../../../../src/operations/geometry/crop';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { expectRunError, makeQuadVideo, near, pixelAt, withDisplayRotation } from './helpers';

let dir = '';
let video = '';
let silent = '';
let quad = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-geo-crop-');
  video = makeVideo(dir, 'in.mp4');
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
  quad = makeQuadVideo(dir, 'quad.mp4');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('crop: aspect 9:16 居中裁出最大竖屏区域，保留音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(crop, { file: [video] }, { aspect: '9:16' });
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 134);
    assert.equal(info.video?.height, 240);
    assert.ok(info.audio, '音轨应保留');
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
    assert.deepEqual(result.data, {
      x: 92,
      y: 0,
      width: 134,
      height: 240,
      sourceWidth: 320,
      sourceHeight: 240,
    });
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('crop: 像素区域裁剪，奇数宽高取偶数，内容来自指定位置', { skip: ffmpegSkip }, async () => {
  // 右下白色块：x 160-320、y 120-240
  const { result, ctx } = await runOperation(
    crop,
    { file: [quad] },
    { x: '170', y: '130', width: '101', height: '81' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 100);
    assert.equal(info.video?.height, 80);
    assert.equal(info.audio, undefined);
    assert.ok(near(pixelAt(result.files[0], 0.5, 50, 40), 'white'));
  } finally {
    await ctx.cleanup();
  }
});

test('crop: anchor=top 贴顶部裁剪', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    crop,
    { file: [quad] },
    { aspect: '16:9', anchor: 'top' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 180);
    assert.deepEqual(result.data, {
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      sourceWidth: 320,
      sourceHeight: 240,
    });
    // 顶部仍是红 / 绿色块
    assert.ok(near(pixelAt(result.files[0], 0.5, 10, 10), 'red'));
    assert.ok(near(pixelAt(result.files[0], 0.5, 310, 10), 'lime'));
  } finally {
    await ctx.cleanup();
  }
});

test('crop: 区域超出源画面时报出源尺寸', { skip: ffmpegSkip }, async () => {
  await expectRunError(
    crop,
    { file: [video] },
    { x: 200, y: 0, width: 200, height: 100 },
    /超出了源视频画面 320x240/,
  );
  await expectRunError(
    crop,
    { file: [video] },
    { width: 400, height: 100 },
    /裁剪尺寸 400x100 超出了源视频画面 320x240/,
  );
});

test(
  'crop: 奇数尺寸的源视频可以选整幅画面和贴边区域，报告真实尺寸',
  { skip: ffmpegSkip },
  async () => {
    // yuv444p 才能编码奇数尺寸的 H.264
    const odd = path.join(dir, 'odd444.mp4');
    generate([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=641x361:rate=25:duration=0.4,format=yuv444p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv444p',
      odd,
    ]);
    const full = await runOperation(crop, { file: [odd] }, { x: 0, y: 0, width: 641, height: 361 });
    try {
      const info = await probeMedia(full.result.files[0]);
      assert.equal(info.video?.width, 640);
      assert.equal(info.video?.height, 360);
      assert.deepEqual(full.result.data, {
        x: 0,
        y: 0,
        width: 640,
        height: 360,
        sourceWidth: 641,
        sourceHeight: 361,
      });
    } finally {
      await full.ctx.cleanup();
    }
    // x + width = 641，在真实画面内；坐标向下取偶数后仍在取偶数后的画面内
    const edge = await runOperation(crop, { file: [odd] }, { x: 1, y: 1, width: 640, height: 360 });
    try {
      assert.deepEqual(edge.result.data, {
        x: 0,
        y: 0,
        width: 640,
        height: 360,
        sourceWidth: 641,
        sourceHeight: 361,
      });
    } finally {
      await edge.ctx.cleanup();
    }
    // 只给宽高、按 anchor 居中时也按真实尺寸校验，摆放在取偶数后的画面里
    const centered = await runOperation(crop, { file: [odd] }, { width: 641, height: 101 });
    try {
      const data = centered.result.data as { y: number; width: number; height: number };
      assert.deepEqual([data.width, data.height], [640, 100]);
      assert.equal(data.y, 130);
    } finally {
      await centered.ctx.cleanup();
    }
    await expectRunError(
      crop,
      { file: [odd] },
      { x: 2, y: 0, width: 640, height: 360 },
      /超出了源视频画面 641x361，x \+ width 不能大于 641/,
    );
    await expectRunError(
      crop,
      { file: [odd] },
      { width: 642, height: 360 },
      /裁剪尺寸 642x360 超出了源视频画面 641x361/,
    );
  },
);

test('crop: 带旋转元数据的视频按摆正后的画面裁剪', { skip: ffmpegSkip }, async () => {
  const rotated = withDisplayRotation(video, path.join(dir, 'rotated.mp4'), 90);
  const { result, ctx } = await runOperation(crop, { file: [rotated] }, { aspect: '1:1' });
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 240);
    assert.equal(info.video?.height, 240);
    assert.equal((result.data as { sourceWidth: number }).sourceWidth, 240);
    assert.equal((result.data as { sourceHeight: number }).sourceHeight, 320);
  } finally {
    await ctx.cleanup();
  }
});

test('crop: 无音轨输入、任意扩展名（URL 下载场景）', { skip: ffmpegSkip }, async () => {
  const odd = path.join(dir, 'download.bin');
  await fs.promises.copyFile(silent, odd);
  const { result, ctx } = await runOperation(crop, { file: [odd] }, { width: 160, height: 120 });
  try {
    assert.ok(result.files[0].endsWith('.mp4'));
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 160);
    assert.equal(info.audio, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('crop: 超过 8K 的源视频裁出的画面仍受尺寸上限约束', { skip: ffmpegSkip }, async () => {
  const huge = path.join(dir, 'huge.avi');
  generate(['-f', 'lavfi', '-i', 'color=black:s=7700x16:d=0.08:r=25', '-c:v', 'mjpeg', huge]);
  await expectRunError(
    crop,
    { file: [huge] },
    { width: 7700, height: 16 },
    /裁剪后的画面 7700x16 超过上限 7680x4320.*请缩小裁剪区域/,
  );
});

test('crop: 纯音频输入报错', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'a.m4a');
  await expectRunError(crop, { file: [audio] }, { aspect: '1:1' }, /输入文件不包含视频画面/);
});

test('crop: 参数校验', () => {
  assert.deepEqual(paramErrors(crop, {}), [
    '请提供 width 和 height（按像素裁剪），或 aspect（按比例裁剪）',
  ]);
  assert.deepEqual(paramErrors(crop, { width: 100 }), ['width 和 height 必须同时提供']);
  assert.deepEqual(paramErrors(crop, { width: 100, height: 100, x: 10 }), ['x 和 y 必须同时提供']);
  assert.deepEqual(paramErrors(crop, { aspect: '1:1', width: 100, height: 100 }), [
    'aspect 不能和 x / y / width / height 同时使用',
  ]);
  assert.deepEqual(paramErrors(crop, { width: 100, height: 100, x: 0, y: 0, anchor: 'top' }), [
    'anchor 不能和 x / y 同时使用',
  ]);
  assert.match(paramErrors(crop, { aspect: '2:1' })[0], /aspect 只能是 16:9 \/ 9:16/);
  assert.deepEqual(paramErrors(crop, { width: 1, height: 100 }), [
    'width 必须是 2 到 8192 之间的整数',
  ]);
  assert.deepEqual(paramErrors(crop, { width: 100, height: 100, x: -1, y: 0 }), [
    'x 必须是 0 到 8192 之间的整数',
  ]);
  // 空字符串视为没传
  assert.deepEqual(paramErrors(crop, { aspect: '4:5', width: '', anchor: '' }), []);
});

test('crop: 比例裁剪的尺寸和锚点计算', () => {
  assert.deepEqual(aspectCropSize('9:16', 1920, 1080), { width: 606, height: 1080 });
  assert.deepEqual(aspectCropSize('16:9', 1080, 1920), { width: 1080, height: 606 });
  assert.deepEqual(aspectCropSize('1:1', 1920, 1080), { width: 1080, height: 1080 });
  assert.deepEqual(aspectCropSize('21:9', 1920, 1080), { width: 1920, height: 822 });
  const p = { aspect: '1:1' as const, anchor: 'right' as const };
  assert.deepEqual(computeCropRect(p, 1920, 1080), { x: 840, y: 0, width: 1080, height: 1080 });
  assert.deepEqual(computeCropRect({ ...p, anchor: 'left' }, 1920, 1080).x, 0);
  assert.deepEqual(computeCropRect({ ...p, anchor: 'bottom' }, 1080, 1920).y, 840);
  // 奇数尺寸：按真实尺寸校验，结果向下取偶数后落在滤镜看到的偶数画面内
  const real = { width: 641, height: 361 };
  assert.deepEqual(computeCropRect({ x: 0, y: 0, width: 641, height: 361 }, 640, 360, real), {
    x: 0,
    y: 0,
    width: 640,
    height: 360,
  });
  assert.deepEqual(computeCropRect({ x: 1, y: 0, width: 640, height: 361 }, 640, 360, real), {
    x: 0,
    y: 0,
    width: 640,
    height: 360,
  });
  assert.deepEqual(computeCropRect({ x: 101, y: 1, width: 540, height: 9 }, 640, 360, real), {
    x: 100,
    y: 0,
    width: 540,
    height: 8,
  });
  assert.throws(
    () => computeCropRect({ x: 0, y: 0, width: 641, height: 361 }, 640, 360),
    /裁剪尺寸 641x361 超出了源视频画面 640x360/,
  );
});
