import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loopOperation } from '../../../../src/operations/timeline/loop';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { frameLuma, makeRampVideo, meanVolumeDb, near } from './helpers';

let dir = '';
let video = '';
let mp3 = '';
/** 画面 2 秒、声音只有 1.5 秒（前 1 秒有音调），用来检查多遍循环后声音是否逐遍提前 */
let shortAudio = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-loop-');
  video = makeVideo(dir, 'v.mp4', { duration: 2 });
  mp3 = makeAudio(dir, 'a.mp3', { duration: 1 });
  shortAudio = makeRampVideo(dir, 'short-audio.mp4', {
    duration: 2,
    toneUntil: 1,
    audioDuration: 1.5,
  });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(loopOperation, {}), []);
  assert.deepEqual(paramErrors(loopOperation, { times: 1 }), ['times 必须是 2 到 100 之间的整数']);
  assert.deepEqual(paramErrors(loopOperation, { times: '2.5' }), [
    'times 必须是 2 到 100 之间的整数',
  ]);
  assert.deepEqual(paramErrors(loopOperation, { duration: 7200 }), [
    'duration 必须大于 0 且不超过 3600 秒（1 小时）',
  ]);
  assert.deepEqual(paramErrors(loopOperation, { duration: 'abc' }), [
    'duration 必须是秒数或 HH:MM:SS 格式的时间',
  ]);
  assert.deepEqual(paramErrors(loopOperation, { times: 3, duration: 10 }), [
    'times 和 duration 只能二选一',
  ]);
  assert.deepEqual(paramErrors(loopOperation, { duration: '00:00:30', mode: 'fast' }), []);
});

test('times=3：重新编码，时长 3 倍', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(loopOperation, { file: [video] }, { times: '3' });
  try {
    assert.deepEqual(result.data, { loops: 3, duration: 6 });
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 6, 0.1), `时长 ${info.duration}`);
    assert.ok(info.video && info.audio);
  } finally {
    await ctx.cleanup();
  }
});

test('duration 不是整数遍时在目标时长截断', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    loopOperation,
    { file: [video] },
    { duration: '00:00:05' },
  );
  try {
    assert.deepEqual(result.data, { loops: 3, duration: 5 });
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 5, 0.1), `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('声音比画面短：每一遍的声音都对齐到这一遍的开头', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(loopOperation, { file: [shortAudio] }, { times: 5 });
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 10, 0.1), `时长 ${info.duration}`);
    // 第 5 遍从 8 秒开始，8.2-8.8 秒应有声音、9.2-9.8 秒应静音；声音逐遍提前的话会整体错位
    assert.ok(meanVolumeDb(result.files[0], 8.2, 0.6) > -40, '第 5 遍开头应有声音');
    assert.ok(meanVolumeDb(result.files[0], 9.2, 0.6) < -60, '第 5 遍后半段应静音');
    // 画面每遍从暗到亮
    assert.ok(frameLuma(result.files[0], 8.1) < frameLuma(result.files[0], 9.8));
  } finally {
    await ctx.cleanup();
  }
});

test('fast 模式流复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    loopOperation,
    { file: [video] },
    { times: 4, mode: 'fast' },
  );
  try {
    assert.ok(result.files[0].endsWith('.mp4'));
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 8, 0.15), `时长 ${info.duration}`);
    assert.equal(info.video?.codec, 'h264');
    assert.equal(info.audio?.codec, 'aac');
  } finally {
    await ctx.cleanup();
  }
});

test('纯音频 mp3：fast 输出 mp3，accurate 输出 m4a', { skip: ffmpegSkip }, async () => {
  const fast = await runOperation(loopOperation, { file: [mp3] }, { times: 3, mode: 'fast' });
  try {
    assert.ok(fast.result.files[0].endsWith('.mp3'));
    const info = await probeMedia(fast.result.files[0]);
    assert.equal(info.video, undefined);
    assert.ok(near(info.duration, 3, 0.15), `时长 ${info.duration}`);
  } finally {
    await fast.ctx.cleanup();
  }
  const accurate = await runOperation(loopOperation, { file: [mp3] }, { duration: 2.5 });
  try {
    assert.ok(accurate.result.files[0].endsWith('.m4a'));
    const info = await probeMedia(accurate.result.files[0]);
    assert.ok(near(info.duration, 2.5, 0.1), `时长 ${info.duration}`);
  } finally {
    await accurate.ctx.cleanup();
  }
});

test('times 让总时长超过 1 小时时报错', { skip: ffmpegSkip }, async () => {
  const long = makeAudio(dir, 'long.wav', { duration: 40, sampleRate: 8000, channels: 1 });
  await assert.rejects(
    runOperation(loopOperation, { file: [long] }, { times: 100 }),
    /循环后总时长 4000 秒超过上限 1 小时/,
  );
});
