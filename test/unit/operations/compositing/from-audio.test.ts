import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fromAudio } from '../../../../src/operations/compositing/from-audio';
import { probeMedia } from '../../../../src/utils/media-probe';
import {
  ffmpegSkip,
  generate,
  makeAudio,
  makeImage,
  makeTempDir,
  makeVideo,
} from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, brightPixels, disguise, pixelAt, runFails } from './fixtures';

let dir = '';
let mp3 = '';
let m4a = '';
let red = '';
let black = '';
let withArt = '';
let silent = '';
let video = '';

const SMALL = { size: '320x240', fps: '10' };

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-fromaudio-');
  mp3 = disguise(makeAudio(dir, 'song.mp3', { duration: 2 }));
  m4a = makeAudio(dir, 'song.m4a', { duration: 2 });
  red = disguise(makeImage(dir, 'red.png', { size: '120x240', color: 'red' }), '.dat');
  black = makeImage(dir, 'black.jpg', { size: '320x240', color: 'black' });
  // 带内嵌封面（attached_pic）的 mp3
  const green = makeImage(dir, 'green.jpg', { size: '64x64', color: 'lime' });
  withArt = path.join(dir, 'art.mp3');
  generate([
    '-i',
    mp3,
    '-i',
    green,
    '-map',
    '0:a',
    '-map',
    '1:v',
    '-c:a',
    'copy',
    '-c:v',
    'mjpeg',
    '-disposition:v',
    'attached_pic',
    '-id3v2_version',
    '3',
    '-f',
    'mp3',
    withArt,
  ]);
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
  video = makeVideo(dir, 'video.mp4', { duration: 2 });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('没有图片时默认波形，时长等于音频', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(fromAudio, { file: [mp3] }, { size: '320x240' });
  try {
    assert.equal(result.files.length, 1);
    const out = result.files[0];
    assert.ok(out.endsWith('.mp4'));
    const media = await probeMedia(out);
    assert.equal(media.video?.codec, 'h264');
    assert.equal(media.video?.pixFmt, 'yuv420p');
    assert.equal(media.video?.width, 320);
    assert.equal(media.video?.height, 240);
    assert.equal(media.video?.frameRate, '25/1');
    assert.ok(Math.abs(media.duration - 2) < 0.15, `时长 ${media.duration}`);
    assert.equal(media.audio?.codec, 'aac');
    // 白色波形画在整个画面的中线附近
    assert.ok(brightPixels(out, 1, { x: 0, y: 100, w: 320, h: 40 }) > 500);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('上传图片默认 cover，contain 留白填背景色', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fromAudio,
    { file: [mp3], image: [red] },
    { ...SMALL, backgroundColor: 'blue' },
  );
  try {
    const out = result.files[0];
    assertNear(pixelAt(out, 1, 160, 120), [255, 0, 0]);
    assertNear(pixelAt(out, 1, 10, 120), [0, 0, 255]);
    const media = await probeMedia(out);
    assert.ok(Math.abs(media.duration - 2) < 0.15, `时长 ${media.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('fit=cover 铺满画面', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fromAudio,
    { file: [mp3], image: [red] },
    { ...SMALL, fit: 'cover', backgroundColor: 'blue' },
  );
  try {
    assertNear(pixelAt(result.files[0], 1, 10, 120), [255, 0, 0]);
  } finally {
    await ctx.cleanup();
  }
});

test('音频内嵌封面自动作为封面', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(fromAudio, { file: [withArt] }, SMALL);
  try {
    assertNear(pixelAt(result.files[0], 1, 160, 120), [0, 255, 0]);
  } finally {
    await ctx.cleanup();
  }
});

test('cover-waveform：波形叠加在封面底部', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fromAudio,
    { file: [mp3], image: [black] },
    { ...SMALL, style: 'cover-waveform', waveHeight: '0.3', waveColor: 'white' },
  );
  try {
    const out = result.files[0];
    assert.ok(brightPixels(out, 1, { x: 0, y: 168, w: 320, h: 72 }) > 300, '底部应有波形');
    assert.equal(brightPixels(out, 1, { x: 0, y: 0, w: 320, h: 160 }), 0, '上方是封面');
  } finally {
    await ctx.cleanup();
  }
});

test('spectrum、bars、cover-spectrum、cover-bars 都能生成', { skip: ffmpegSkip }, async () => {
  const cases: [string, Record<string, string[]>][] = [
    ['spectrum', { file: [mp3] }],
    ['bars', { file: [mp3] }],
    ['cover-spectrum', { file: [mp3], image: [black] }],
    ['cover-bars', { file: [mp3], image: [black] }],
  ];
  for (const [style, inputs] of cases) {
    const { result, ctx } = await runOperation(fromAudio, inputs, {
      ...SMALL,
      style,
      spectrumColor: 'magma',
      wavePosition: 'center',
    });
    try {
      const media = await probeMedia(result.files[0]);
      assert.equal(media.video?.width, 320, style);
      assert.equal(media.video?.height, 240, style);
      assert.ok(Math.abs(media.duration - 2) < 0.2, `${style} 时长 ${media.duration}`);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('start / duration 截取一段，AAC 输入和视频输入', { skip: ffmpegSkip }, async () => {
  const trimmed = await runOperation(
    fromAudio,
    { file: [m4a] },
    { ...SMALL, start: '0.5', duration: '1' },
  );
  try {
    const media = await probeMedia(trimmed.result.files[0]);
    assert.ok(Math.abs(media.duration - 1) < 0.15, `时长 ${media.duration}`);
    assert.equal(media.audio?.codec, 'aac');
  } finally {
    await trimmed.ctx.cleanup();
  }
  // 带音轨的视频也可以作为输入，只用它的声音
  const fromVideo = await runOperation(fromAudio, { file: [video] }, SMALL);
  try {
    const media = await probeMedia(fromVideo.result.files[0]);
    assert.ok(Math.abs(media.duration - 2) < 0.15, `时长 ${media.duration}`);
  } finally {
    await fromVideo.ctx.cleanup();
  }
});

test('没有音轨、缺少封面、截取越界、图片无效时任务失败', { skip: ffmpegSkip }, async () => {
  await runFails(fromAudio, { file: [silent] }, SMALL, /输入文件不包含音频/);
  await runFails(
    fromAudio,
    { file: [mp3] },
    { ...SMALL, style: 'cover-waveform' },
    /style=cover-waveform 需要封面图/,
  );
  await runFails(
    fromAudio,
    { file: [mp3] },
    { ...SMALL, start: '5' },
    /start（5 秒）超出了音频时长/,
  );
  await runFails(fromAudio, { file: [mp3], image: [m4a] }, SMALL, /封面图不包含视频画面/);
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(fromAudio, { style: 'waveform' }, { file: 1, image: 1 }), [
    'style=waveform 不使用图片；要把可视化叠加在图片上请用 style=cover-waveform',
  ]);
  assert.match(paramErrors(fromAudio, { style: 'video' })[0], /^style 只能是 cover \/ waveform/);
  assert.deepEqual(paramErrors(fromAudio, { size: '5000x5000' }), [
    'size 不能超过 3840x2160（总像素）',
  ]);
  assert.deepEqual(paramErrors(fromAudio, { size: '9000x100' }), [
    'size 必须是 宽x高 格式，如 1280x720（每边 2-8192）',
  ]);
  assert.deepEqual(paramErrors(fromAudio, { fps: '0' }), ['fps 必须是 1 到 60 之间的数字']);
  assert.deepEqual(paramErrors(fromAudio, { waveHeight: '2' }), [
    'waveHeight 必须是 0.1 到 1 之间的数字',
  ]);
  assert.deepEqual(paramErrors(fromAudio, { duration: '0' }), ['duration 必须大于 0']);
  assert.match(paramErrors(fromAudio, { waveColor: 'rgb(1,2,3)' })[0], /waveColor 必须是颜色名/);
  assert.deepEqual(paramErrors(fromAudio, { style: 'cover-waveform' }, { file: 1, image: 1 }), []);
  // 奇数尺寸自动减 1
  assert.deepEqual(fromAudio.params.parse({ size: '321x241' }).size, { width: 320, height: 240 });
  assert.deepEqual(fromAudio.params.parse({}).size, { width: 1280, height: 720 });
});
