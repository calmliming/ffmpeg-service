import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { pip, pipLayout } from '../../../../src/operations/geometry/pip';
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
import { expectRunError, makeColorVideo, makeQuadVideo, near, pixelAt } from './helpers';

let dir = '';
let main = '';
let mainSilent = '';
let redClip = '';
let redLong = '';
let yellowPng = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-geo-pip-');
  // 主视频：四色块（左上红、右上绿、左下蓝、右下白），2 秒，带音轨
  main = makeQuadVideo(dir, 'main.mp4', { duration: 2, audio: true });
  mainSilent = makeVideo(dir, 'silent.mp4', { audio: false });
  redClip = makeColorVideo(dir, 'red.mp4', { color: 'red', duration: 1, audio: true });
  redLong = makeColorVideo(dir, 'red-long.mp4', { color: 'red', duration: 3 });
  yellowPng = makeImage(dir, 'logo.png', { size: '100x100', color: 'yellow' });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('pip: 默认右下角 30% 宽，视频素材播完后消失，保留主音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(pip, { file: [main], overlay: [redClip] });
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
    assert.equal(info.audio?.codec, 'aac');
    assert.deepEqual(result.data, { width: 96, height: 72, x: 204, y: 148, overlayType: 'video' });
    // 小画面区域在右下白色块上
    assert.ok(near(pixelAt(out, 0.5, 252, 184), 'red'));
    assert.ok(near(pixelAt(out, 1.6, 252, 184), 'white'), '素材播完后小画面应消失');
    assert.ok(near(pixelAt(out, 0.5, 190, 184), 'white'), '小画面以外不受影响');
  } finally {
    await ctx.cleanup();
  }
});

test('pip: loopOverlay 循环播放较短的素材', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    pip,
    { file: [main], overlay: [redClip] },
    { loopOverlay: 'true' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
    assert.ok(near(pixelAt(result.files[0], 1.6, 252, 184), 'red'));
  } finally {
    await ctx.cleanup();
  }
});

test('pip: 素材比主视频长时按主视频截断', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(pip, { file: [main], overlay: [redLong] });
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('pip: 图片素材、边框，一直显示到结尾', { skip: ffmpegSkip }, async () => {
  // 上传的图片扩展名不可信，换个扩展名也要能识别
  const odd = path.join(dir, 'logo.dat');
  await fs.promises.copyFile(yellowPng, odd);
  const { result, ctx } = await runOperation(
    pip,
    { file: [main], overlay: [odd] },
    { position: 'top-left', width: 0.25, border: 4, borderColor: 'blue' },
  );
  try {
    const out = result.files[0];
    assert.deepEqual(result.data, { width: 80, height: 80, x: 20, y: 20, overlayType: 'image' });
    assert.ok(near(pixelAt(out, 0.3, 21, 21), 'blue'), '边框');
    assert.ok(near(pixelAt(out, 0.3, 60, 60), 'yellow'), '图片');
    assert.ok(near(pixelAt(out, 1.9, 60, 60), 'yellow'), '图片应一直显示');
    assert.ok(near(pixelAt(out, 0.3, 10, 10), 'red'), '边距外是主画面');
  } finally {
    await ctx.cleanup();
  }
});

test('pip: startTime / endTime 控制显示时段', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    pip,
    { file: [main], overlay: [yellowPng] },
    { position: 'center', width: 0.5, startTime: '0.5', endTime: '00:00:01.2' },
  );
  try {
    const out = result.files[0];
    // 中央 160x160 的小画面盖住左上红色块的 (150, 110)
    assert.ok(near(pixelAt(out, 0.2, 150, 110), 'red'), '开始前不显示');
    assert.ok(near(pixelAt(out, 0.8, 150, 110), 'yellow'), '时段内显示');
    assert.ok(near(pixelAt(out, 1.6, 150, 110), 'red'), '结束后不显示');
  } finally {
    await ctx.cleanup();
  }
});

test('pip: opacity 半透明', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    pip,
    { file: [main], overlay: [yellowPng] },
    { position: 'top-left', width: 0.25, opacity: 0.5 },
  );
  try {
    // 黄色 50% 叠在红色上 ≈ (255, 128, 0)
    const [r, g, b] = pixelAt(result.files[0], 0.5, 50, 50);
    assert.ok(r > 200 && g > 80 && g < 180 && b < 60, `混合后的颜色 ${[r, g, b]}`);
  } finally {
    await ctx.cleanup();
  }
});

test('pip: 声音来源 overlay / mix，缺音轨时的处理', { skip: ffmpegSkip }, async () => {
  const overlayAudio = await runOperation(
    pip,
    { file: [main], overlay: [redClip] },
    { audio: 'overlay', startTime: 0.5 },
  );
  try {
    const info = await probeMedia(overlayAudio.result.files[0]);
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
  } finally {
    await overlayAudio.ctx.cleanup();
  }

  const mixed = await runOperation(pip, { file: [main], overlay: [redClip] }, { audio: 'mix' });
  try {
    const info = await probeMedia(mixed.result.files[0]);
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
  } finally {
    await mixed.ctx.cleanup();
  }

  // 主视频无声时 mix 只用小画面的声音
  const silentMain = await runOperation(
    pip,
    { file: [mainSilent], overlay: [redClip] },
    { audio: 'mix' },
  );
  try {
    assert.ok((await probeMedia(silentMain.result.files[0])).audio);
  } finally {
    await silentMain.ctx.cleanup();
  }

  // 主视频无声、audio=main：输出无音轨
  const noAudio = await runOperation(pip, { file: [mainSilent], overlay: [yellowPng] });
  try {
    assert.equal((await probeMedia(noAudio.result.files[0])).audio, undefined);
  } finally {
    await noAudio.ctx.cleanup();
  }

  await expectRunError(
    pip,
    { file: [main], overlay: [yellowPng] },
    { audio: 'overlay' },
    /audio=overlay 需要画中画素材带音轨/,
  );
});

test('pip: mix 混合采样率、声道不同的两路声音', { skip: ffmpegSkip }, async () => {
  // 主视频 48kHz 立体声，素材 22.05kHz 单声道
  const mono = path.join(dir, 'mono.mkv');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=red:s=160x120:d=1:r=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=22050:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'libopus',
    '-ac',
    '1',
    '-shortest',
    mono,
  ]);
  const { result, ctx } = await runOperation(
    pip,
    { file: [main], overlay: [mono] },
    { audio: 'mix', startTime: 0.5 },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.codec, 'aac');
    assert.equal(info.audio?.sampleRate, 48000);
    assert.equal(info.audio?.channels, 2);
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('pip: 素材没有画面、startTime 超出主视频时长时报错', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'a.mp3');
  await expectRunError(
    pip,
    { file: [main], overlay: [audio] },
    {},
    /画中画素材不包含视频画面（overlay 需要视频或图片）/,
  );
  await expectRunError(
    pip,
    { file: [main], overlay: [yellowPng] },
    { startTime: 5 },
    /startTime 5 秒超出了主视频时长/,
  );
});

test('pip: 参数校验', () => {
  const provided = { file: 1, overlay: 1 };
  assert.deepEqual(paramErrors(pip, {}, provided), []);
  assert.deepEqual(paramErrors(pip, { width: 0.95 }, provided), [
    'width 必须是 0.05 到 0.9 之间的数字',
  ]);
  assert.deepEqual(paramErrors(pip, { startTime: 3, endTime: 2 }, provided), [
    'endTime 必须大于 startTime',
  ]);
  assert.match(paramErrors(pip, { position: 'middle' }, provided)[0], /position 只能是/);
  assert.match(paramErrors(pip, { startTime: 'abc' }, provided)[0], /startTime 必须是秒数/);
  assert.match(paramErrors(pip, { audio: 'both' }, provided)[0], /audio 只能是 main \/ mix/);
  assert.deepEqual(paramErrors(pip, { border: 101 }, provided), [
    'border 必须是 0 到 100 之间的整数',
  ]);
});

test('pip: 布局计算：过高的素材缩小，位置夹在画面内', () => {
  const p = { width: 0.9, margin: 20, border: 0, position: 'bottom-right' as const };
  assert.deepEqual(pipLayout({ width: 320, height: 240 }, { width: 100, height: 400 }, p), {
    width: 60,
    height: 240,
    x: 240,
    y: 0,
  });
  assert.deepEqual(
    pipLayout(
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { ...p, width: 0.25, border: 6, position: 'top' },
    ),
    { width: 480, height: 270, x: 714, y: 20 },
  );
  // 很宽的素材加粗边框：按宽度上限（主画面宽减两侧边框）缩小，整个框仍在画面内
  assert.deepEqual(
    pipLayout({ width: 160, height: 120 }, { width: 320, height: 90 }, { ...p, border: 30 }),
    { width: 100, height: 28, x: 0, y: 12 },
  );
  assert.throws(
    () => pipLayout({ width: 160, height: 120 }, { width: 100, height: 100 }, { ...p, border: 60 }),
    /边框 60 像素太宽，主画面 160x120 放不下小画面，请调小 border/,
  );
});

test('pip: 宽素材加粗边框时连边框一起缩进主画面', { skip: ffmpegSkip }, async () => {
  const wide = makeImage(dir, 'wide.png', { size: '320x60', color: 'yellow' });
  const { result, ctx } = await runOperation(
    pip,
    { file: [main], overlay: [wide] },
    { width: 0.9, border: 20, borderColor: 'blue' },
  );
  try {
    const out = result.files[0];
    // 宽度上限 320 - 2x20 = 280，框宽 320 正好贴满主画面
    assert.deepEqual(result.data, { width: 280, height: 52, x: 0, y: 128, overlayType: 'image' });
    assert.ok(near(pixelAt(out, 0.5, 8, 150), 'blue'), '左边框');
    assert.ok(near(pixelAt(out, 0.5, 312, 150), 'blue'), '右边框在画面内');
    assert.ok(near(pixelAt(out, 0.5, 160, 174), 'yellow'), '素材');
    assert.ok(near(pixelAt(out, 0.5, 10, 10), 'red'), '框外是主画面');
  } finally {
    await ctx.cleanup();
  }
});

test(
  'pip: loopOverlay 用小画面的声音时，循环接缝处没有静音空洞',
  { skip: ffmpegSkip },
  async () => {
    // 0.6 秒带 AAC 音轨的小视频循环到 2 秒：直接 -stream_loop 压缩音频时每个接缝有 20-45 ms 空洞
    const shortClip = makeVideo(dir, 'short-with-audio.mp4', { duration: 0.6, freq: 660 });
    const { result, ctx } = await runOperation(
      pip,
      { file: [mainSilent], overlay: [shortClip] },
      { loopOverlay: 'true', audio: 'overlay' },
    );
    try {
      const run = spawnSync(
        config.ffmpegPath,
        [
          '-hide_banner',
          '-i',
          result.files[0],
          '-af',
          'silencedetect=n=-40dB:d=0.005',
          '-f',
          'null',
          '-',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr.slice(-300));
      const gaps = run.stderr.match(/silence_start: [d.]+/g) ?? [];
      assert.deepEqual(gaps, [], '循环接缝处出现静音');
    } finally {
      await ctx.cleanup();
    }
  },
);
