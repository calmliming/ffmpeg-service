import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { speedOperation } from '../../../../src/operations/timeline/speed';
import { atempoChain } from '../../../../src/operations/timeline/shared';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { near, toneFrequency } from './helpers';

let dir = '';
let video = '';
let silent = '';
let audio = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-speed-');
  video = makeVideo(dir, 'v.mp4', { duration: 2 });
  silent = makeVideo(dir, 'silent.mp4', { duration: 2, audio: false });
  // 扩展名不可信：URL 下载来的文件可能没有正确扩展名，按探测结果处理
  audio = makeAudio(dir, 'a.wav', { duration: 2 });
  const renamed = path.join(dir, 'a.bin');
  fs.renameSync(audio, renamed);
  audio = renamed;
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('atempoChain 把超出 0.5-2 的倍数拆成多级', () => {
  assert.deepEqual(atempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepEqual(atempoChain(3), ['atempo=2', 'atempo=1.5']);
  assert.deepEqual(atempoChain(1.5), ['atempo=1.5']);
  assert.deepEqual(atempoChain(1), ['atempo=1']);
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(speedOperation, {}), ['factor 必须是 0.25 到 4 之间的数字']);
  assert.deepEqual(paramErrors(speedOperation, { factor: '5' }), [
    'factor 必须是 0.25 到 4 之间的数字',
  ]);
  assert.deepEqual(paramErrors(speedOperation, { factor: 'abc' }), [
    'factor 必须是 0.25 到 4 之间的数字',
  ]);
  assert.deepEqual(paramErrors(speedOperation, { factor: 2, interpolation: 'magic' }), [
    'interpolation 只能是 none / blend / motion',
  ]);
  assert.deepEqual(paramErrors(speedOperation, { factor: 2, fps: 240 }), [
    'fps 必须是 1 到 120 之间的数字',
  ]);
  assert.deepEqual(paramErrors(speedOperation, { factor: '0.5', keepPitch: 'false' }), []);
});

test('2 倍速：时长减半，帧率不变，音画都在', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(speedOperation, { file: [video] }, { factor: '2' });
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 1, 0.1), `时长 ${info.duration}`);
    assert.ok(info.video && info.audio);
    assert.equal(info.video.frameRate, '25/1');
    assert.ok(result.files[0].endsWith('.mp4'));
    // 默认保持音调：440 Hz 加速后还是 440 Hz
    const freq = toneFrequency(result.files[0], 0.1, 0.6);
    assert.ok(near(freq, 440, 15), `频率 ${freq}`);
    const last = ctx.progressCalls[ctx.progressCalls.length - 1];
    assert.equal(last.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('0.5 倍慢放 + 变调 + blend 补帧', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    speedOperation,
    { file: [video] },
    { factor: 0.5, keepPitch: false, interpolation: 'blend', fps: 30 },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 4, 0.15), `时长 ${info.duration}`);
    assert.equal(info.video?.frameRate, '30/1');
    assert.ok(info.audio);
    // 变调模式：慢放一半，440 Hz 变成 220 Hz
    const freq = toneFrequency(result.files[0], 0.5, 1);
    assert.ok(near(freq, 220, 10), `频率 ${freq}`);
  } finally {
    await ctx.cleanup();
  }
});

test('motion 补帧慢放', { skip: ffmpegSkip }, async () => {
  const short = makeVideo(dir, 'short.mp4', { duration: 1, audio: false });
  const { result, ctx } = await runOperation(
    speedOperation,
    { file: [short] },
    { factor: 0.5, interpolation: 'motion' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 2, 0.15), `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('没有音轨的视频 4 倍速', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(speedOperation, { file: [silent] }, { factor: 4 });
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 0.5, 0.1), `时长 ${info.duration}`);
    assert.equal(info.audio, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('纯音频 0.25 倍，扩展名不对也按探测结果输出 m4a', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(speedOperation, { file: [audio] }, { factor: 0.25 });
  try {
    assert.ok(result.files[0].endsWith('.m4a'));
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 8, 0.15), `时长 ${info.duration}`);
    assert.equal(info.video, undefined);
    assert.equal(info.audio?.codec, 'aac');
  } finally {
    await ctx.cleanup();
  }
});

test('纯音频不能 mute', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(speedOperation, { file: [audio] }, { factor: 2, mute: true }),
    /纯音频文件不能设置 mute=true/,
  );
});

test('mute 去掉声音', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    speedOperation,
    { file: [video] },
    { factor: 1.5, mute: 'true' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio, undefined);
    assert.ok(near(info.duration, 2 / 1.5, 0.1), `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
});
