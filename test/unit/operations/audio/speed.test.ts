import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  asetrateFilter,
  atempoChain,
  rubberbandFilter,
  speedOperation,
} from '../../../../src/operations/audio/speed';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, bandVolume, makeOffsetVideo } from './audio-helpers';

let dir = '';
let tone = '';
let video = '';
let offsetVideo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-speed-');
  tone = makeAudio(dir, 'tone.wav', { duration: 2, freq: 440 });
  video = makeVideo(dir, 'clip.mp4', { duration: 2 });
  // 画面 4 秒，3 秒的音轨晚 1 秒才开始
  offsetVideo = makeOffsetVideo(dir, 'offset.mp4', {
    videoDuration: 4,
    audioExpr: '0.5*sin(2*PI*440*t)',
    audioDuration: 3,
    offset: 1,
  });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('tempo=2：时长减半，音高不变（atempo）', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(speedOperation, { file: [tone] }, { tempo: '2' });
  try {
    assert.equal(path.extname(result.files[0]), '.wav');
    assert.deepEqual(result.data, { tempo: 2, pitch: 0, engine: 'atempo' });
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 1, 0.05, 'duration');
    assert.ok(bandVolume(result.files[0], 440) > bandVolume(result.files[0], 880) + 10);
  } finally {
    await ctx.cleanup();
  }
});

test('pitch=12：升高一个八度，时长不变（rubberband）', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    speedOperation,
    { file: [tone] },
    {
      pitch: 12,
      preserveFormant: 'true',
    },
  );
  try {
    assert.deepEqual(result.data, { tempo: 1, pitch: 12, engine: 'rubberband' });
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 2, 0.05, 'duration');
    const at440 = bandVolume(result.files[0], 440);
    const at880 = bandVolume(result.files[0], 880);
    assert.ok(at880 > at440 + 10, `880 Hz ${at880} dB，440 Hz ${at440} dB`);
  } finally {
    await ctx.cleanup();
  }
});

test('同时变速变调：视频输入输出纯音频，时长 = 原时长 / tempo', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    speedOperation,
    { file: [video] },
    {
      tempo: 0.5,
      pitch: -3,
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.mp3');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video, undefined);
    assertNear(info.duration, 4, 0.15, 'duration');
    assert.ok(ctx.progressCalls.length > 0);
  } finally {
    await ctx.cleanup();
  }
});

test('音轨晚于画面开始：只变调时保留完整时长，结尾不被裁掉', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    speedOperation,
    { file: [offsetVideo] },
    { pitch: 2, format: 'wav' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    // 时间戳没归零时 atrim=end 按绝对时间裁，丢掉最后约 1 秒
    assertNear(info.duration, 3, 0.1, 'duration');
  } finally {
    await ctx.cleanup();
  }
});

test('asetrate 退回方案生成的滤镜能被 FFmpeg 接受', { skip: ffmpegSkip }, async () => {
  const ctx = createTestContext({ file: [tone] });
  try {
    const out = ctx.tempPath('fallback.wav');
    await ctx.ffmpeg(['-i', tone, '-af', asetrateFilter(1.5, 5, 44100), '-y', out]);
    const info = await probeMedia(out);
    assertNear(info.duration, 2 / 1.5, 0.05, 'duration');
    assert.equal(info.audio?.sampleRate, 44100);
  } finally {
    await ctx.cleanup();
  }
});

test('atempoChain 每级限制在 0.5-2，滤镜只含数字', () => {
  assert.deepEqual(atempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(atempoChain(3), ['atempo=2', 'atempo=1.5']);
  assert.deepEqual(atempoChain(0.5), ['atempo=0.5']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepEqual(atempoChain(1), ['atempo=1']);
  assert.equal(rubberbandFilter(1, 12, false), 'rubberband=tempo=1:pitch=2');
  assert.equal(
    rubberbandFilter(1.25, -12, true),
    'rubberband=tempo=1.25:pitch=0.5:formant=preserved',
  );
  assert.equal(asetrateFilter(1, 12, 48000), 'asetrate=96000,aresample=48000,atempo=0.5');
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(speedOperation, {}), [
    '请设置 tempo（不等于 1）或 pitch（不等于 0）',
  ]);
  assert.match(paramErrors(speedOperation, { tempo: 5 })[0], /tempo 必须是 0.5 到 4 之间的数字/);
  assert.match(paramErrors(speedOperation, { pitch: -13 })[0], /pitch 必须是 -12 到 12 之间的数字/);
  assert.match(
    paramErrors(speedOperation, { pitch: 2, preserveFormant: 'y' })[0],
    /preserveFormant 必须是布尔值/,
  );
  assert.deepEqual(paramErrors(speedOperation, { tempo: '1.25', pitch: '-0.5' }), []);
});
