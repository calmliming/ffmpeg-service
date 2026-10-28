import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, generate, makeAudio, makeImage, makeTempDir } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  checkOutputSize,
  encodeArgs,
  imageConvert,
  isOpaqueColor,
  opaqueColor,
  planAlpha,
  type ConvertParams,
} from '../../../../src/operations/analysis/image-convert';
import { probeMedia, probeRaw } from '../../../../src/utils/media-probe';
import {
  addExifOrientation,
  averageColor,
  closeColor,
  pixelColor,
  runExpectingError,
} from './helpers';

let dir = '';
let png = '';
let jpg = '';
let transparent = '';
let rotated = '';
let gif = '';
let animatedWebp = '';
let audio = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-image-');
  png = makeImage(dir, 'pattern.png');
  jpg = makeImage(dir, 'photo.jpg');
  // 64x64 全透明底上画一个 32x32 的不透明红色方块（drawbox 要 replace=1 才会写 alpha）
  transparent = path.join(dir, 'transparent.png');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x00000000:size=64x64,format=rgba,drawbox=x=16:y=16:w=32:h=32:color=red:t=fill:replace=1',
    '-frames:v',
    '1',
    transparent,
  ]);
  rotated = addExifOrientation(jpg, path.join(dir, 'rotated.jpg'), 6);
  gif = path.join(dir, 'anim.gif');
  generate(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=1', gif]);
  animatedWebp = path.join(dir, 'anim.webp');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=5:duration=1',
    '-c:v',
    'libwebp_anim',
    '-loop',
    '0',
    animatedWebp,
  ]);
  audio = makeAudio(dir, 'tone.wav', { duration: 1 });
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface ImageData {
  format: string;
  width: number;
  height: number;
  size: number;
  quality: number | null;
  alpha: boolean;
  sourceWidth: number;
  sourceHeight: number;
}

async function convert(file: string, raw: Record<string, unknown>) {
  const run = await runOperation(imageConvert, { file: [file] }, raw);
  const out = run.result.files[0];
  return { ...run, out, data: run.result.data as ImageData, info: await probeMedia(out) };
}

test('image.convert：png 转 jpg 并按宽度等比缩放', { skip: ffmpegSkip }, async () => {
  const { result, ctx, out, data, info } = await convert(png, { format: 'jpeg', width: '160' });
  try {
    assert.equal(result.files.length, 1);
    assert.equal(result.primary, out);
    assert.equal(path.dirname(out), ctx.outputRoot);
    assert.equal(path.extname(out), '.jpg');
    assert.equal(info.video?.codec, 'mjpeg');
    assert.deepEqual([info.video?.width, info.video?.height], [160, 120]);
    assert.deepEqual(
      [data.format, data.width, data.height, data.quality, data.alpha],
      ['jpg', 160, 120, 85, false],
    );
    assert.equal(data.size, fs.statSync(out).size);
    assert.deepEqual([data.sourceWidth, data.sourceHeight], [320, 240]);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('image.convert：cover / contain / stretch 三种缩放', { skip: ffmpegSkip }, async () => {
  const cover = await convert(jpg, { format: 'webp', width: 100, height: 100, fit: 'cover' });
  try {
    assert.equal(cover.info.video?.codec, 'webp');
    assert.deepEqual([cover.info.video?.width, cover.info.video?.height], [100, 100]);
  } finally {
    await cover.ctx.cleanup();
  }
  const contain = await convert(png, { width: 200, height: 200 });
  try {
    // 不给背景色时不补边，输出比框小一边；沿用输入格式 png
    assert.equal(contain.data.format, 'png');
    assert.deepEqual([contain.info.video?.width, contain.info.video?.height], [200, 150]);
  } finally {
    await contain.ctx.cleanup();
  }
  const padded = await convert(png, { width: 200, height: 200, background: '#000000' });
  try {
    assert.deepEqual([padded.info.video?.width, padded.info.video?.height], [200, 200]);
    // 上下各补 25 像素黑边，补边后不透明，去掉 alpha 通道
    assert.ok(closeColor(pixelColor(padded.out, 100, 5), [0, 0, 0, 255], 2));
    assert.ok(!closeColor(pixelColor(padded.out, 100, 100), [0, 0, 0, 255], 20));
    assert.equal(padded.info.video?.pixFmt, 'rgb24');
    assert.equal(padded.data.alpha, false);
  } finally {
    await padded.ctx.cleanup();
  }
  const stretch = await convert(png, { format: 'bmp', width: 100, height: 50, fit: 'stretch' });
  try {
    assert.equal(stretch.info.video?.codec, 'bmp');
    assert.deepEqual([stretch.info.video?.width, stretch.info.video?.height], [100, 50]);
    assert.equal(stretch.data.quality, null);
  } finally {
    await stretch.ctx.cleanup();
  }
});

test(
  'image.convert：透明图转 jpg 铺白底，png / webp / avif 保留透明',
  { skip: ffmpegSkip },
  async () => {
    const toJpg = await convert(transparent, { format: 'jpg', quality: 95 });
    try {
      assert.ok(closeColor(pixelColor(toJpg.out, 2, 2), [255, 255, 255]), '透明区域应为白色');
      assert.ok(closeColor(pixelColor(toJpg.out, 32, 32), [255, 0, 0], 30), '方块应为红色');
      assert.equal(toJpg.data.alpha, false);
    } finally {
      await toJpg.ctx.cleanup();
    }
    const toPng = await convert(transparent, { width: 32 });
    try {
      assert.equal(toPng.info.video?.pixFmt, 'rgba');
      assert.equal(pixelColor(toPng.out, 1, 1)[3], 0);
      assert.equal(pixelColor(toPng.out, 16, 16)[3], 255);
      assert.equal(toPng.data.alpha, true);
    } finally {
      await toPng.ctx.cleanup();
    }
    const blue = await convert(transparent, { background: 'blue' });
    try {
      // 给了不透明背景色时 png 也铺底，输出不再带透明通道
      assert.equal(blue.info.video?.pixFmt, 'rgb24');
      assert.ok(closeColor(pixelColor(blue.out, 2, 2), [0, 0, 255, 255]));
      assert.ok(closeColor(pixelColor(blue.out, 32, 32), [255, 0, 0, 255]));
    } finally {
      await blue.ctx.cleanup();
    }
    const webp = await convert(transparent, { format: 'webp' });
    try {
      assert.equal(webp.info.video?.pixFmt, 'yuva420p');
      assert.equal(webp.data.alpha, true);
    } finally {
      await webp.ctx.cleanup();
    }
    const avif = await convert(transparent, { format: 'avif', quality: 70 });
    try {
      assert.equal(avif.info.video?.codec, 'av1');
      assert.equal(avif.data.alpha, true);
      // 彩色图像 + alpha 辅助图层
      const raw = await probeRaw(avif.out);
      const streams = (raw.streams as { codec_type: string }[]).filter(
        (s) => s.codec_type === 'video',
      );
      assert.equal(streams.length, 2);
    } finally {
      await avif.ctx.cleanup();
    }
  },
);

test('image.convert：avif / tiff / 无损 webp', { skip: ffmpegSkip }, async () => {
  const avif = await convert(jpg, { format: 'avif', width: 161 });
  try {
    assert.equal(avif.info.video?.codec, 'av1');
    assert.deepEqual([avif.info.video?.width, avif.info.video?.height], [161, 121]);
    assert.deepEqual([avif.data.quality, avif.data.alpha], [60, false]);
  } finally {
    await avif.ctx.cleanup();
  }
  const tiff = await convert(jpg, { format: 'tif' });
  try {
    assert.equal(tiff.info.video?.codec, 'tiff');
    assert.equal(tiff.info.video?.pixFmt, 'rgb24');
    assert.equal(tiff.data.format, 'tiff');
    assert.equal(path.extname(tiff.out), '.tiff');
  } finally {
    await tiff.ctx.cleanup();
  }
  const lossless = await convert(png, { format: 'webp', lossless: 'true' });
  try {
    assert.equal(lossless.data.quality, null);
    // 无损：和原图逐像素一致
    assert.deepEqual(pixelColor(lossless.out, 100, 100), pixelColor(png, 100, 100));
  } finally {
    await lossless.ctx.cleanup();
  }
});

test('image.convert：按 EXIF 方向摆正并去掉 EXIF', { skip: ffmpegSkip }, async () => {
  const { ctx, out, info } = await convert(rotated, { format: 'png' });
  try {
    assert.deepEqual([info.video?.width, info.video?.height], [240, 320]);
    const bytes = fs.readFileSync(out);
    assert.equal(bytes.includes(Buffer.from('eXIf')), false);
    assert.equal(bytes.includes(Buffer.from('Exif')), false);
  } finally {
    await ctx.cleanup();
  }
  const jpgOut = await convert(rotated, {});
  try {
    assert.equal(jpgOut.data.format, 'jpg');
    assert.deepEqual([jpgOut.info.video?.width, jpgOut.info.video?.height], [240, 320]);
    assert.equal(fs.readFileSync(jpgOut.out).includes(Buffer.from('Exif')), false);
  } finally {
    await jpgOut.ctx.cleanup();
  }
});

test('image.convert：动图只取第一帧', { skip: ffmpegSkip }, async () => {
  const fromGif = await convert(gif, {});
  try {
    assert.equal(fromGif.data.format, 'png');
    assert.equal(fromGif.info.video?.codec, 'png');
    assert.deepEqual([fromGif.info.video?.width, fromGif.info.video?.height], [160, 120]);
  } finally {
    await fromGif.ctx.cleanup();
  }
  // FFmpeg 8 不能解码动态 WebP（探测出的宽高是 0），FFmpeg 9 可以
  const probed = await probeMedia(animatedWebp);
  if ((probed.video?.width ?? 0) > 0) {
    const fromWebp = await convert(animatedWebp, { format: 'png' });
    try {
      assert.deepEqual([fromWebp.info.video?.width, fromWebp.info.video?.height], [160, 120]);
    } finally {
      await fromWebp.ctx.cleanup();
    }
  } else {
    const { error, outputs } = await runExpectingError(imageConvert, { file: [animatedWebp] });
    assert.match(error.message, /无法读取图片尺寸/);
    assert.deepEqual(outputs, []);
  }
});

test('image.convert：运行时才能发现的错误', { skip: ffmpegSkip }, async () => {
  const notImage = await runExpectingError(imageConvert, { file: [audio] });
  assert.equal(notImage.error.message, '输入文件不是图片（没有画面）');
  const tooBig = await runExpectingError(imageConvert, { file: [png] }, { width: 16000 });
  assert.match(tooBig.error.message, /输出尺寸约 16000x12000，超过上限/);
  // 不传 format 时沿用输入的 jpg，jpg 不支持无损
  const lossless = await runExpectingError(imageConvert, { file: [jpg] }, { lossless: true });
  assert.equal(lossless.error.message, 'jpg 不支持无损压缩，请改用 png 或 webp');
});

test('image.convert：参数校验', () => {
  assert.deepEqual(paramErrors(imageConvert, { format: 'gif' }), [
    'format 只能是 png / jpg / webp / avif / bmp / tiff',
  ]);
  assert.deepEqual(paramErrors(imageConvert, { quality: '0' }), [
    'quality 必须是 1 到 100 之间的整数',
  ]);
  assert.deepEqual(paramErrors(imageConvert, { width: '20000' }), [
    'width 必须是 1 到 16383 之间的整数',
  ]);
  assert.deepEqual(paramErrors(imageConvert, { fit: 'cover', width: '100' }), [
    'fit=cover 需要同时提供 width 和 height',
  ]);
  assert.deepEqual(paramErrors(imageConvert, { fit: 'fill' }), [
    'fit 只能是 contain / cover / stretch',
  ]);
  assert.deepEqual(paramErrors(imageConvert, { format: 'jpg', lossless: 'true' }), [
    'jpg 不支持无损压缩，请改用 png 或 webp',
  ]);
  assert.deepEqual(paramErrors(imageConvert, { background: 'url(x)' }), [
    'background 必须是颜色名（如 white）、#RRGGBB 或 #RRGGBBAA，可带 @透明度（如 white@0.5）',
  ]);
  assert.deepEqual(
    paramErrors(imageConvert, { format: 'JPEG', width: '10', height: '10', fit: 'stretch' }),
    [],
  );
});

const params = (extra: Partial<ConvertParams> = {}): ConvertParams => ({
  fit: 'contain',
  lossless: false,
  ...extra,
});

test('image.convert：透明通道和背景色的处理规则', () => {
  assert.equal(isOpaqueColor('white'), true);
  assert.equal(isOpaqueColor('white@0.5'), false);
  assert.equal(isOpaqueColor('0x112233'), true);
  assert.equal(isOpaqueColor('0x112233FF'), true);
  assert.equal(isOpaqueColor('0x11223380'), false);
  assert.equal(opaqueColor('0x11223380'), '0x112233');
  assert.equal(opaqueColor('red@0.3'), 'red');

  // jpg 没有透明：透明区域默认铺白，背景色的透明度被忽略
  assert.deepEqual(planAlpha('jpg', true, params()), {
    flatten: 'white',
    padColor: undefined,
    outputAlpha: false,
    dropAlpha: true,
  });
  assert.equal(planAlpha('jpg', true, params({ background: '0x00000000' })).flatten, '0x000000');
  // png 保留透明；不透明背景色铺底；半透明背景色只补边
  assert.equal(planAlpha('png', true, params()).outputAlpha, true);
  assert.deepEqual(planAlpha('png', true, params({ background: 'black' })), {
    flatten: 'black',
    padColor: undefined,
    outputAlpha: false,
    dropAlpha: true,
  });
  assert.deepEqual(
    planAlpha('png', false, params({ width: 10, height: 10, background: '0x00000000' })),
    { flatten: undefined, padColor: '0x00000000', outputAlpha: true, dropAlpha: false },
  );
  assert.deepEqual(planAlpha('webp', false, params()), {
    flatten: undefined,
    padColor: undefined,
    outputAlpha: false,
    dropAlpha: false,
  });
});

test('image.convert：尺寸估算和质量映射', () => {
  assert.equal(checkOutputSize(params({ width: 800 }), 4000, 3000), undefined);
  assert.match(checkOutputSize(params({ width: 16000 }), 320, 240) ?? '', /超过上限/);
  // EXIF 旋转后的方向未知，只要有一个方向不超限就放行
  assert.equal(checkOutputSize(params({ height: 16000 }), 1000, 200), undefined);
  // 按比例算出不足 1 像素的边由 FFmpeg 兜底，不拒绝
  assert.equal(checkOutputSize(params({ width: 1 }), 10000, 10), undefined);
  assert.match(checkOutputSize(params(), 20000, 20000) ?? '', /超过上限/);

  const q = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(q(encodeArgs('jpg', 100, false, false), '-q:v'), '2');
  assert.equal(q(encodeArgs('jpg', 1, false, false), '-q:v'), '31');
  assert.equal(q(encodeArgs('jpg', 95, false, false), '-pix_fmt'), 'yuvj444p');
  assert.equal(q(encodeArgs('avif', 100, false, false), '-crf'), '1');
  assert.equal(q(encodeArgs('avif', 1, false, false), '-crf'), '63');
  assert.equal(q(encodeArgs('avif', 50, true, false), '-crf'), '0');
  assert.equal(q(encodeArgs('webp', 42, false, true), '-quality'), '42');
  assert.equal(q(encodeArgs('webp', 42, false, true), '-pix_fmt'), 'yuva420p');
  assert.equal(q(encodeArgs('tiff', 100, false, true), '-pix_fmt'), 'rgba');
});
