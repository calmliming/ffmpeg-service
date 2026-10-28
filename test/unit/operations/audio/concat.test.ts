import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { concatAudioOperation, concatGraph } from '../../../../src/operations/audio/concat';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, bandVolume, makePipedWebm, volumeOf, withoutExtension } from './audio-helpers';

interface ConcatData {
  inputs: number;
  duration: number;
  sampleRate: number;
  channels: number;
}

let dir = '';
let wavStereo = '';
let mp3Mono = '';
let video = '';
let silentVideo = '';
let short = '';
let noDuration = '';
let long = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-concat-');
  wavStereo = makeAudio(dir, 'a.wav', { duration: 1, freq: 440, sampleRate: 44100, channels: 2 });
  mp3Mono = withoutExtension(
    makeAudio(dir, 'b.mp3', { duration: 1, freq: 880, sampleRate: 22050, channels: 1 }),
  );
  video = makeVideo(dir, 'c.mp4', { duration: 1, freq: 660 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
  short = makeAudio(dir, 'short.wav', { duration: 0.4 });
  // 管道写出的 webm 没有时长信息（浏览器 MediaRecorder 录音常见）
  noDuration = makePipedWebm(dir, 'nodur.weba', [
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:a',
    'libopus',
  ]);
  long = makeAudio(dir, 'long.mp3', { duration: 4, freq: 880 });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('采样率、声道、格式都不同的三个文件按顺序拼接', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(concatAudioOperation, {
    files: [wavStereo, mp3Mono, video],
  });
  try {
    // 沿用第 1 个文件的格式
    assert.equal(path.extname(result.files[0]), '.wav');
    const data = result.data as ConcatData;
    assert.equal(data.inputs, 3);
    assert.equal(data.sampleRate, 48000);
    assert.equal(data.channels, 2);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.sampleRate, 48000);
    assert.equal(info.audio?.channels, 2);
    assertNear(info.duration, 3, 0.1, 'duration');
    // 顺序不变：第 2 段是 880 Hz，第 3 段是 660 Hz
    const seg2 = { start: 1.2, duration: 0.6 };
    const seg3 = { start: 2.2, duration: 0.6 };
    const out = result.files[0];
    assert.ok(bandVolume(out, 880, seg2) > bandVolume(out, 440, seg2) + 10);
    assert.ok(bandVolume(out, 660, seg3) > bandVolume(out, 880, seg3) + 10);
    // 单声道的第 2 段复制到两个声道，音量和原文件一样
    assertNear(
      volumeOf(out, seg2).mean,
      volumeOf(mp3Mono, { start: 0.2, duration: 0.6 }).mean,
      0.5,
      '单声道段音量',
    );
    const phases = ctx.progressCalls.map((c) => c.extra?.phase).filter(Boolean);
    assert.deepEqual(phases, ['analyzing', 'merging']);
  } finally {
    await ctx.cleanup();
  }
});

test('crossfade：相邻两段重叠，总时长减少，中间没有静音', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    concatAudioOperation,
    { files: [wavStereo, video] },
    { crossfade: '0.5', curve: 'qsin', format: 'opus' },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.opus');
    const data = result.data as ConcatData;
    assertNear(data.duration, 1.5, 0.05, 'data.duration');
    // opus 只支持 48 kHz 等采样率，统一的采样率按输出格式选
    assert.equal(data.sampleRate, 48000);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.codec, 'opus');
    assertNear(info.duration, 1.5, 0.1, 'duration');
    assert.ok(volumeOf(result.files[0], { start: 0.6, duration: 0.3 }).mean > -25);
  } finally {
    await ctx.cleanup();
  }
});

test('有输入拿不到时长时，data.duration 是实际输出的长度', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    concatAudioOperation,
    { files: [noDuration, long] },
    { crossfade: 1, format: 'wav' },
  );
  try {
    const data = result.data as ConcatData;
    // 3 + 4 - 1；按探测时长相加会得到 0 + 4 - 1 = 3
    assertNear(data.duration, 6, 0.1, 'data.duration');
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 6, 0.1, 'duration');
  } finally {
    await ctx.cleanup();
  }
});

test('文件比 crossfade 短或没有音轨时给出是第几个文件', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(concatAudioOperation, { files: [wavStereo, short] }, { crossfade: 0.5 }),
    /第 2 个文件只有 0.4 秒，不比 crossfade（0.5 秒）长/,
  );
  await assert.rejects(
    runOperation(concatAudioOperation, { files: [wavStereo, silentVideo] }),
    /第 2 个文件没有音轨/,
  );
});

test('concatGraph：直接拼接用 concat，交叉淡化两两串联 acrossfade', () => {
  const target = { sampleRate: 48000, channels: 2 as const };
  assert.equal(
    concatGraph([2, 1], target, 0, 'tri'),
    '[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0];' +
      '[1:a:0]pan=stereo|c0=c0|c1=c0,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
      'asetpts=PTS-STARTPTS[a1];' +
      '[a0][a1]concat=n=2:v=0:a=1[out]',
  );
  const graph = concatGraph([1, 1, 1], { sampleRate: 44100, channels: 1 }, 1.5, 'exp');
  assert.ok(graph.includes('[a0][a1]acrossfade=d=1.5:c1=exp:c2=exp[x1]'));
  assert.ok(graph.endsWith('[x1][a2]acrossfade=d=1.5:c1=exp:c2=exp[out]'));
  assert.ok(graph.includes('channel_layouts=mono'));
  assert.ok(!graph.includes('pan='));
});

test('参数校验', () => {
  assert.match(
    paramErrors(concatAudioOperation, { crossfade: 31 }, { files: 2 })[0],
    /crossfade 必须是 0 到 30 之间的数字/,
  );
  assert.match(
    paramErrors(concatAudioOperation, { curve: 'smooth' }, { files: 2 })[0],
    /curve 只能是 tri/,
  );
  assert.deepEqual(
    paramErrors(concatAudioOperation, { crossfade: '1', format: 'm4a' }, { files: 3 }),
    [],
  );
  const slot = concatAudioOperation.inputs[0];
  assert.deepEqual(slot.multiple, { min: 2, max: 50 });
  assert.equal(concatAudioOperation.chainable, undefined);
});
