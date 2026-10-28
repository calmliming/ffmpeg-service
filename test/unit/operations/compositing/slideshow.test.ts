import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  planChunks,
  planSlideshow,
  slideshow,
  XFADE_TRANSITIONS,
} from '../../../../src/operations/compositing/slideshow';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeImage, makeTempDir } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import {
  assertNear,
  audioGaps,
  disguise,
  maxVolume,
  pixelAt,
  runFails,
  silences,
  streamsOf,
} from './fixtures';

// 12 种容易区分的颜色，验证分段拼接后每张图出现在正确的帧上
const COLORS: [string, [number, number, number]][] = [
  ['red', [255, 0, 0]],
  ['lime', [0, 255, 0]],
  ['blue', [0, 0, 255]],
  ['yellow', [255, 255, 0]],
  ['magenta', [255, 0, 255]],
  ['cyan', [0, 255, 255]],
  ['white', [255, 255, 255]],
  ['black', [0, 0, 0]],
  ['orange', [255, 165, 0]],
  ['purple', [128, 0, 128]],
  ['teal', [0, 128, 128]],
  ['gray', [128, 128, 128]],
];
const FORMATS = ['png', 'jpg', 'webp', 'bmp'];
const SIZES = ['200x150', '120x240', '640x360', '333x111'];

let dir = '';
let colored: string[] = [];
let mixed: string[] = [];
let transparent = '';
let audio1 = '';
let audio2 = '';
let tone = '';
let notImage = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-slides-');
  // 尺寸、格式混用，扩展名不可信
  colored = COLORS.map(([color], i) =>
    disguise(
      makeImage(dir, `c${i}.${FORMATS[i % FORMATS.length]}`, {
        size: SIZES[i % SIZES.length],
        color,
      }),
    ),
  );
  mixed = [
    makeImage(dir, 'm1.png', { size: '400x300' }),
    makeImage(dir, 'm2.jpg', { size: '200x400', color: 'orange' }),
    makeImage(dir, 'm3.webp', { size: '640x360', color: 'teal' }),
  ];
  // 全透明的 PNG，透明部分应当显示 backgroundColor
  transparent = path.join(dir, 'alpha.png');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=red@0.0:size=100x100,format=rgba',
    '-frames:v',
    '1',
    transparent,
  ]);
  audio1 = disguise(makeAudio(dir, 'one.mp3', { duration: 1 }));
  audio2 = makeAudio(dir, 'two.m4a', { duration: 2 });
  tone = makeAudio(dir, 'tone.m4a', { duration: 1, freq: 330 });
  notImage = makeAudio(dir, 'not-image.wav', { duration: 1 });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('planSlideshow：按帧计算时间轴', () => {
  const plan = planSlideshow({ count: 3, fps: 25, durationPerImage: 1, transitionDuration: 0.5 });
  // 0.5 秒 = 12.5 帧，不能超过单张 25 帧的一半，取 12
  assert.deepEqual(plan.frames, [25, 25, 25]);
  assert.equal(plan.transitionFrames, 12);
  assert.deepEqual(plan.starts, [0, 13, 26]);
  assert.equal(plan.totalFrames, 51);

  const single = planSlideshow({ count: 1, fps: 25, durationPerImage: 3, transitionDuration: 1 });
  assert.equal(single.transitionFrames, 0);
  assert.equal(single.totalFrames, 75);

  // fitToAudio：总帧数严格等于音频时长
  const fit = planSlideshow({
    count: 7,
    fps: 30,
    durationPerImage: 3,
    transitionDuration: 0.5,
    fitDuration: 10,
  });
  assert.equal(fit.totalFrames, 300);
  assert.equal(fit.transitionFrames, 15);
  // 音频不够长时自动缩短转场
  const tight = planSlideshow({
    count: 4,
    fps: 25,
    durationPerImage: 3,
    transitionDuration: 3,
    fitDuration: 4,
  });
  assert.equal(tight.totalFrames, 100);
  assert.ok(tight.transitionFrames * 2 <= Math.min(...tight.frames));
  assert.throws(
    () =>
      planSlideshow({
        count: 10,
        fps: 25,
        durationPerImage: 3,
        transitionDuration: 0.5,
        fitDuration: 2,
      }),
    /音频太短/,
  );
  // 回归：转场帧数取整后超过单张一半时，总帧数仍然等于音频时长
  const rounded = planSlideshow({
    count: 3,
    fps: 25,
    durationPerImage: 3,
    transitionDuration: 0.5,
    fitDuration: 2,
  });
  assert.equal(rounded.totalFrames, 50);
  // 各种组合下：总帧数严格等于音频时长，转场不超过单张的一半
  for (const count of [2, 3, 7, 10, 33, 100]) {
    for (const fps of [1, 24, 25, 30, 60]) {
      for (const fit of [count * 0.6, 7.3, 61, 600]) {
        for (const t of [0, 0.2, 0.5, 3]) {
          let plan;
          try {
            plan = planSlideshow({
              count,
              fps,
              durationPerImage: 3,
              transitionDuration: t,
              fitDuration: fit,
            });
          } catch (err) {
            assert.match((err as Error).message, /音频太短/);
            continue;
          }
          const label = `count=${count} fps=${fps} fit=${fit} t=${t}`;
          assert.equal(plan.totalFrames, Math.max(1, Math.round(fit * fps)), label);
          assert.ok(plan.transitionFrames * 2 <= Math.min(...plan.frames), label);
          assert.ok(Math.min(...plan.frames) >= 1, label);
        }
      }
    }
  }
});

test('planChunks：分段拼接后总帧数不变，各段首尾相接', () => {
  const configs = [
    { count: 1, transitionDuration: 0 },
    { count: 10, transitionDuration: 0.5 },
    { count: 11, transitionDuration: 0.5 },
    { count: 25, transitionDuration: 1 },
    { count: 100, transitionDuration: 0 },
    { count: 100, transitionDuration: 0.3 },
  ];
  for (const c of configs) {
    const plan = planSlideshow({ ...c, fps: 25, durationPerImage: 2 });
    for (const size of [3, 10]) {
      const chunks = planChunks(plan, size);
      const sum = chunks.reduce((n, ch) => n + ch.trimEnd - ch.trimStart, 0);
      assert.equal(sum, plan.totalFrames, `count=${c.count} chunk=${size}`);
      // 每张图恰好属于一个段（衔接的那张在两段里都出现）
      const seen = new Set(chunks.flatMap((ch) => ch.images));
      assert.equal(seen.size, c.count);
      for (const ch of chunks) assert.ok(ch.trimEnd > ch.trimStart);
    }
  }
});

test('混合尺寸和格式的图片，contain 留白、透明图填背景色', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    slideshow,
    { images: [...mixed, transparent] },
    { size: '320x240', durationPerImage: '1', transitionDuration: '0.2', backgroundColor: 'blue' },
  );
  try {
    assert.equal(result.files.length, 1);
    const out = result.files[0];
    assert.ok(out.endsWith('.mp4'));
    const media = await probeMedia(out);
    assert.equal(media.video?.codec, 'h264');
    assert.equal(media.video?.pixFmt, 'yuv420p');
    assert.equal(media.video?.width, 320);
    assert.equal(media.video?.height, 240);
    assert.equal(media.audio, undefined, '没有 audio 时不应有音轨');
    // 4 张 × 25 帧 − 3 × 5 帧转场 = 85 帧
    assert.ok(Math.abs(media.duration - 3.4) < 0.08, `时长 ${media.duration}`);
    // 第 2 张是竖图：左右留白
    assertNear(pixelAt(out, 1.4, 10, 120), [0, 0, 255]);
    assertNear(pixelAt(out, 1.4, 160, 120), [255, 165, 0]);
    // 最后一张全透明
    assertNear(pixelAt(out, 3.2, 160, 120), [0, 0, 255]);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('超过 10 张时分段渲染，拼接处每张图出现在正确的帧上', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    slideshow,
    { images: colored },
    { size: '160x120', fps: '10', durationPerImage: '1', transitionDuration: '0.2', fit: 'cover' },
  );
  try {
    const out = result.files[0];
    // 每张 10 帧，转场 2 帧：11 × 8 + 10 = 98 帧
    const v = (await streamsOf(out)).find((s) => s.codec_type === 'video');
    assert.equal(v?.nb_frames, '98');
    // 第 i 张图从第 8i 帧开始，8i+2 到 8i+7 帧完全显示；取中间那帧
    for (let i = 0; i < COLORS.length; i++) {
      const time = (8 * i + 4.5) / 10;
      assertNear(pixelAt(out, time, 80, 60), COLORS[i][1], 50);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('fitToAudio：视频与音频等长，音频结尾淡出', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    slideshow,
    { images: mixed, audio: [audio2] },
    { size: '320x240', fitToAudio: 'true', audioFadeOut: '0.5', kenBurns: 'true' },
  );
  try {
    const out = result.files[0];
    const media = await probeMedia(out);
    assert.ok(Math.abs(media.duration - 2) < 0.08, `时长 ${media.duration}`);
    assert.equal(media.audio?.codec, 'aac');
    assert.ok(maxVolume(out, 1.92, 0.08) < maxVolume(out, 0.5, 0.5) - 6, '结尾应当淡出');
  } finally {
    await ctx.cleanup();
  }
});

test('音频比视频短：默认补静音，loopAudio 循环', { skip: ffmpegSkip }, async () => {
  const base = { size: '160x120', durationPerImage: '1', transition: 'none', audioFadeOut: '0' };
  const padded = await runOperation(slideshow, { images: mixed, audio: [audio1] }, base);
  try {
    const out = padded.result.files[0];
    const media = await probeMedia(out);
    assert.ok(Math.abs(media.duration - 3) < 0.08, `时长 ${media.duration}`);
    assert.ok(maxVolume(out, 0.2, 0.5) > -30);
    assert.ok(maxVolume(out, 2, 0.8) < -60, '音频结束后应当静音');
  } finally {
    await padded.ctx.cleanup();
  }
  const looped = await runOperation(
    slideshow,
    { images: mixed, audio: [audio1] },
    { ...base, loopAudio: 'true' },
  );
  try {
    assert.ok(maxVolume(looped.result.files[0], 2, 0.8) > -30, 'loopAudio 时循环播放');
  } finally {
    await looped.ctx.cleanup();
  }
});

test('loopAudio：循环无缝，接缝处没有静音和时间戳空洞', { skip: ffmpegSkip }, async () => {
  // 回归：m4a 直接 -stream_loop，每一遍多出约 20-45 ms（编码延迟 + 补齐），音轨留下空洞并逐遍漂移
  const { result, ctx } = await runOperation(
    slideshow,
    { images: mixed.slice(0, 2), audio: [tone] },
    {
      size: '160x120',
      fps: 10,
      durationPerImage: '2.5',
      transition: 'none',
      loopAudio: 'true',
      audioFadeOut: '0',
    },
  );
  try {
    const out = result.files[0];
    assert.deepEqual(audioGaps(out), [], '时间戳空洞');
    assert.deepEqual(
      silences(out).filter((s) => s.start < 4.95),
      [],
      '接缝处的静音',
    );
    assert.ok(maxVolume(out, 4.6, 0.3) > -30, '一直循环到视频结尾');
  } finally {
    await ctx.cleanup();
  }
});

test('Ken Burns + random 转场 + blur 适配', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    slideshow,
    { images: mixed },
    {
      size: '320x180',
      durationPerImage: '1',
      transition: 'random',
      kenBurns: true,
      fit: 'blur',
      fps: 30,
    },
  );
  try {
    const media = await probeMedia(result.files[0]);
    assert.equal(media.video?.width, 320);
    assert.equal(media.video?.height, 180);
    assert.equal(media.video?.frameRate, '30/1');
    // 3 × 30 − 2 × 15 = 60 帧
    assert.ok(Math.abs(media.duration - 2) < 0.08, `时长 ${media.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('单张图片：时长等于 durationPerImage', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    slideshow,
    { images: [mixed[0]] },
    { size: '160x120', durationPerImage: '0.5' },
  );
  try {
    const media = await probeMedia(result.files[0]);
    assert.ok(Math.abs(media.duration - 0.5) < 0.05, `时长 ${media.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('坏图片、音频无音轨、音频太短时任务失败', { skip: ffmpegSkip }, async () => {
  await runFails(
    slideshow,
    { images: [mixed[0], notImage] },
    { size: '160x120' },
    /第 2 张图片不包含视频画面/,
  );
  await runFails(
    slideshow,
    { images: mixed, audio: [mixed[0]] },
    { size: '160x120' },
    /音频文件不包含音频/,
  );
  await runFails(
    slideshow,
    { images: colored, audio: [audio1] },
    { size: '160x120', fitToAudio: true },
    /音频太短/,
  );
});

test('取消任务时立即停止', { skip: ffmpegSkip }, async () => {
  const controller = new AbortController();
  const ctx = createTestContext({ images: mixed }, { signal: controller.signal });
  try {
    const params = slideshow.params.parse({
      size: '1920x1080',
      durationPerImage: 20,
      kenBurns: true,
    });
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('用户取消')), 500);
    await assert.rejects(slideshow.run(ctx, params), /用户取消/);
    assert.ok(Date.now() - started < 5000, '取消后应当很快结束');
  } finally {
    await ctx.cleanup();
  }
});

test('参数校验', () => {
  const provided = { images: 3 };
  assert.deepEqual(paramErrors(slideshow, { transitionDuration: '2' }, provided), [
    'transitionDuration 不能超过 durationPerImage 的一半（每张图的转入和转出不能重叠）',
  ]);
  // 单张图没有转场，不检查
  assert.deepEqual(paramErrors(slideshow, { transitionDuration: '2' }, { images: 1 }), []);
  assert.deepEqual(paramErrors(slideshow, { fitToAudio: 'true' }, provided), [
    'fitToAudio=true 需要上传 audio 音频',
  ]);
  assert.deepEqual(paramErrors(slideshow, { fitToAudio: 'true' }, { images: 3, audio: 1 }), []);
  assert.deepEqual(paramErrors(slideshow, { durationPerImage: '0.1' }, provided), [
    'durationPerImage 必须是 0.5 到 60 之间的数字',
  ]);
  assert.deepEqual(paramErrors(slideshow, { transitionDuration: '5' }, provided), [
    'transitionDuration 必须是 0.2 到 3 之间的数字',
  ]);
  assert.match(
    paramErrors(slideshow, { transition: 'spin' }, provided)[0],
    /^transition 只能是 none \/ random \/ fade/,
  );
  assert.deepEqual(paramErrors(slideshow, { fps: '61' }, provided), [
    'fps 必须是 1 到 60 之间的数字',
  ]);
  assert.deepEqual(paramErrors(slideshow, { fit: 'stretch' }, provided), [
    'fit 只能是 contain / cover / blur',
  ]);
  assert.deepEqual(paramErrors(slideshow, { size: '7680x4320' }, provided), [
    'size 不能超过 3840x2160（总像素）',
  ]);
  assert.deepEqual(
    paramErrors(slideshow, { transition: 'SlideLeft', kenBurns: 'yes' }, provided),
    [],
  );
  assert.ok(XFADE_TRANSITIONS.length >= 50);
});
