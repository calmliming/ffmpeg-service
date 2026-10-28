import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fadeOperation } from '../../../../src/operations/audio/fade';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, makeOffsetVideo, volumeOf } from './audio-helpers';

let dir = '';
let tone = '';
let video = '';
let shortAudioVideo = '';
let offsetVideo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-fade-');
  tone = makeAudio(dir, 'tone.m4a', { duration: 3 });
  video = makeVideo(dir, 'clip.mp4', { duration: 2 });
  // 画面 3 秒、音轨 2 秒
  shortAudioVideo = path.join(dir, 'short-audio.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25:duration=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    shortAudioVideo,
  ]);
  // 画面 6 秒，5 秒的正弦音轨晚 1 秒才开始
  offsetVideo = makeOffsetVideo(dir, 'offset.mp4', {
    videoDuration: 6,
    audioExpr: '0.5*sin(2*PI*440*t)',
    audioDuration: 5,
    offset: 1,
  });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('淡入淡出：开头和结尾明显变小，中间不变，时长不变', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fadeOperation,
    { file: [tone] },
    {
      fadeIn: '1',
      fadeOut: '1',
      curve: 'qsin',
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.m4a');
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 3, 0.1, 'duration');
    const middle = volumeOf(result.files[0], { start: 1.2, duration: 0.6 }).mean;
    assertNear(middle, volumeOf(tone, { start: 1.2, duration: 0.6 }).mean, 0.5, 'middle');
    // qsin 起步很快，只看最开头 / 最末尾 0.1 秒
    const head = volumeOf(result.files[0], { start: 0, duration: 0.1 }).mean;
    const tail = volumeOf(result.files[0], { start: 2.88, duration: 0.1 }).mean;
    assert.ok(head < middle - 15, `开头 ${head} dB，中间 ${middle} dB`);
    assert.ok(tail < middle - 15, `结尾 ${tail} dB，中间 ${middle} dB`);
  } finally {
    await ctx.cleanup();
  }
});

test('只淡出：视频输入输出纯音频 mp3', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(fadeOperation, { file: [video] }, { fadeOut: 0.5 });
  try {
    assert.equal(path.extname(result.files[0]), '.mp3');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video, undefined);
    const head = volumeOf(result.files[0], { start: 0.2, duration: 0.3 }).mean;
    const tail = volumeOf(result.files[0], { start: 1.85, duration: 0.1 }).mean;
    assert.ok(tail < head - 10, `结尾 ${tail} dB，开头 ${head} dB`);
  } finally {
    await ctx.cleanup();
  }
});

test('音轨比画面短的视频：按音轨时长淡出，结尾真正淡到无声', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fadeOperation,
    { file: [shortAudioVideo] },
    {
      fadeOut: 1,
      format: 'wav',
    },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 2, 0.05, 'duration');
    const end = info.duration;
    const tail = volumeOf(result.files[0], { start: end - 0.05, duration: 0.05 }).mean;
    assert.ok(tail < -40, `最后 50 ms ${tail} dB`);
  } finally {
    await ctx.cleanup();
  }
});

test('音轨晚于画面开始：淡入从音轨开头算起，淡出正好在结尾结束', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fadeOperation,
    { file: [offsetVideo] },
    { fadeIn: 1, fadeOut: 2, format: 'wav' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 5, 0.1, 'duration');
    const end = info.duration;
    const middle = volumeOf(result.files[0], { start: 1.5, duration: 1 }).mean;
    // 淡入：开头 0.1 秒明显小于中间（时间戳没归零时淡入发生在音轨开始之前，开头是满音量）
    const head = volumeOf(result.files[0], { start: 0, duration: 0.1 }).mean;
    assert.ok(head < middle - 15, `开头 ${head} dB，中间 ${middle} dB`);
    // 线性淡出 2 秒，倒数第 1 秒约在一半幅度（-6 dB）；淡出提前结束时这里已经是静音
    const fading = volumeOf(result.files[0], { start: end - 1.1, duration: 0.2 }).mean;
    assertNear(fading, middle - 6, 3, 'fade-out midpoint');
    const tail = volumeOf(result.files[0], { start: end - 0.1, duration: 0.1 }).mean;
    assert.ok(tail < middle - 15, `结尾 ${tail} dB，中间 ${middle} dB`);
  } finally {
    await ctx.cleanup();
  }
});

test('淡入加淡出超过音频时长时任务失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(fadeOperation, { file: [tone] }, { fadeIn: 2, fadeOut: 2 }),
    /淡入加淡出共 4 秒，超过了音频时长/,
  );
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(fadeOperation, {}), ['请设置 fadeIn 或 fadeOut（秒）']);
  assert.deepEqual(paramErrors(fadeOperation, { fadeIn: '0', fadeOut: '' }), [
    '请设置 fadeIn 或 fadeOut（秒）',
  ]);
  assert.match(paramErrors(fadeOperation, { fadeIn: -1 })[0], /fadeIn 必须是 0 到 600 之间的数字/);
  assert.match(paramErrors(fadeOperation, { fadeOut: 'long' })[0], /fadeOut 必须是 0 到 600/);
  assert.match(paramErrors(fadeOperation, { fadeIn: 1, curve: 'linear' })[0], /curve 只能是 tri/);
  assert.deepEqual(paramErrors(fadeOperation, { fadeIn: 1, curve: 'EXP' }), []);
});
