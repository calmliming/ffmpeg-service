import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { volumeOperation } from '../../../../src/operations/audio/volume';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, volumeOf, withoutExtension } from './audio-helpers';

let dir = '';
let tone = '';
let loud = '';
let mp3NoExt = '';
let silentVideo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-volume-');
  tone = makeAudio(dir, 'tone.wav', { duration: 1 });
  // sine 源振幅是 1/8，乘 7 后峰值约 -0.6 dBFS
  loud = makeAudio(dir, 'loud.wav', { duration: 1, volume: 7 });
  mp3NoExt = withoutExtension(makeAudio(dir, 'tone.mp3', { duration: 1 }));
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('gain=-6 把音量降低 6 dB，减小时不加限幅器', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(volumeOperation, { file: [tone] }, { gain: '-6' });
  try {
    assert.equal(path.extname(result.files[0]), '.wav');
    assertNear(volumeOf(result.files[0]).mean, volumeOf(tone).mean - 6, 0.2, 'mean');
    assert.deepEqual(result.data, { gain: -6, factor: null, limiter: false });
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 1, 0.01, 'duration');
  } finally {
    await ctx.cleanup();
  }
});

test('放大时默认加限幅器，峰值不削波', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(volumeOperation, { file: [loud] }, { factor: 4 });
  try {
    assert.equal((result.data as { limiter: boolean }).limiter, true);
    const { max } = volumeOf(result.files[0]);
    assert.ok(max <= -0.1, `峰值 ${max} dB`);
  } finally {
    await ctx.cleanup();
  }
  // 关掉限幅器就会削到 0 dBFS
  const raw = await runOperation(
    volumeOperation,
    { file: [loud] },
    { factor: 4, limiter: 'false' },
  );
  try {
    assert.equal((raw.result.data as { limiter: boolean }).limiter, false);
    assert.equal(volumeOf(raw.result.files[0]).max, 0);
  } finally {
    await raw.ctx.cleanup();
  }
});

test('factor=0 输出静音；没有扩展名的 mp3 按内容沿用 mp3', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    volumeOperation,
    { file: [mp3NoExt] },
    { factor: '0' },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.mp3');
    // mp3 解码出来的静音约 -91 dB，不是绝对的 0
    assert.ok(volumeOf(result.files[0]).max < -80);
  } finally {
    await ctx.cleanup();
  }
});

test('没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(volumeOperation, { file: [silentVideo] }, { gain: 3 }),
    /输入文件没有音轨/,
  );
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(volumeOperation, {}), ['请提供 gain（分贝）或 factor（倍数）']);
  assert.deepEqual(paramErrors(volumeOperation, { gain: 3, factor: 2 }), [
    'gain 和 factor 只能提供其中一个',
  ]);
  assert.match(paramErrors(volumeOperation, { gain: 61 })[0], /gain 必须是 -60 到 60 之间的数字/);
  assert.match(paramErrors(volumeOperation, { factor: -1 })[0], /factor 必须是 0 到 10 之间的数字/);
  assert.match(
    paramErrors(volumeOperation, { gain: 3, limiter: 'maybe' })[0],
    /limiter 必须是布尔值/,
  );
  assert.deepEqual(paramErrors(volumeOperation, { gain: '', factor: '1.5' }), []);
});
