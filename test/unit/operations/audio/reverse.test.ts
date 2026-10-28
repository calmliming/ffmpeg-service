import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_REVERSE_SECONDS,
  reverseLimitProblem,
  reverseOperation,
} from '../../../../src/operations/audio/reverse';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, makeExprAudio, volumeOf } from './audio-helpers';

let dir = '';
let halves = '';
let video = '';
let silentVideo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-reverse-');
  // 前 1 秒有声音，后 1 秒静音
  halves = makeExprAudio(dir, 'halves.wav', 'if(lt(t,1),0.5*sin(2*PI*440*t),0)', 2);
  video = makeVideo(dir, 'clip.mp4', { duration: 1 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('倒放后声音和静音调换位置，时长不变', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(reverseOperation, { file: [halves] }, {});
  try {
    assert.equal(path.extname(result.files[0]), '.wav');
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 2, 0.01, 'duration');
    assert.ok(volumeOf(result.files[0], { start: 0.1, duration: 0.8 }).max < -80);
    assert.ok(volumeOf(result.files[0], { start: 1.1, duration: 0.8 }).mean > -20);
  } finally {
    await ctx.cleanup();
  }
});

test('指定 ogg 输出；视频输入取音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    reverseOperation,
    { file: [video] },
    { format: 'ogg' },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.ogg');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.codec, 'vorbis');
    assert.equal(info.video, undefined);
    assertNear(info.duration, 1, 0.1, 'duration');
  } finally {
    await ctx.cleanup();
  }
});

test('没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(runOperation(reverseOperation, { file: [silentVideo] }, {}), /没有音轨/);
});

test('超过内存预算的长音频给出明确错误', () => {
  assert.equal(reverseLimitProblem(MAX_REVERSE_SECONDS, 48000, 2), undefined);
  assert.equal(reverseLimitProblem(600, 44100, 2), undefined);
  assert.match(
    reverseLimitProblem(MAX_REVERSE_SECONDS + 60, 48000, 2) ?? '',
    /音频太长（31 分钟），倒放需要整段读进内存，当前采样率和声道下最长 30 分钟/,
  );
  // 96 kHz 5.1 声道时上限缩短到 5 分钟
  assert.match(reverseLimitProblem(400, 96000, 6) ?? '', /最长 5 分钟/);
  assert.equal(reverseLimitProblem(0, 48000, 2), '无法获取音频时长，不能倒放');
});

test('参数校验', () => {
  assert.match(paramErrors(reverseOperation, { format: 'wma' })[0], /format 只能是 mp3/);
  assert.match(paramErrors(reverseOperation, { bitrate: '1000k' })[0], /bitrate 必须是 8k 到 512k/);
  assert.deepEqual(paramErrors(reverseOperation, { format: 'flac' }), []);
});
