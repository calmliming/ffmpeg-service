import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trimAudioOperation } from '../../../../src/operations/audio/trim';
import { probeMedia, probeRaw } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, makeExprAudio, makeOffsetVideo, volumeOf } from './audio-helpers';

let dir = '';
let wav = '';
let steps = '';
let video = '';
let offsetVideo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-trim-');
  wav = makeAudio(dir, 'tone.wav', { duration: 3 });
  // 前 1 秒静音，之后是声音：用来确认裁剪起点准确
  steps = makeExprAudio(dir, 'steps.wav', 'if(lt(t,1),0,0.5*sin(2*PI*440*t))', 3);
  video = makeVideo(dir, 'clip.mp4', { duration: 2 });
  // 画面 4 秒，3 秒的音轨晚 1 秒才开始；音轨前 1 秒 440 Hz、之后静音
  offsetVideo = makeOffsetVideo(dir, 'offset.mp4', {
    videoDuration: 4,
    audioExpr: 'if(lt(t,1),0.5*sin(2*PI*440*t),0)',
    audioDuration: 3,
    offset: 1,
  });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** wav 的精确采样点数 */
async function sampleCount(file: string): Promise<number> {
  const raw = await probeRaw(file);
  const streams = raw.streams as { duration_ts?: number }[];
  return Number(streams[0].duration_ts);
}

test('startTime + duration 按采样点精确裁剪', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trimAudioOperation,
    { file: [wav] },
    {
      startTime: '0.5',
      duration: '1',
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.wav');
    assert.equal(await sampleCount(result.files[0]), 44100);
    assert.deepEqual(result.data, { start: 0.5, end: 1.5, duration: 1 });
  } finally {
    await ctx.cleanup();
  }
});

test('HH:MM:SS 格式的起止时间，起点准确落在声音开始处', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trimAudioOperation,
    { file: [steps] },
    {
      startTime: '00:00:01',
      endTime: '0:02.5',
    },
  );
  try {
    assert.equal(await sampleCount(result.files[0]), 66150);
    // 开头 10 ms 就是声音
    assert.ok(volumeOf(result.files[0], { start: 0, duration: 0.01 }).mean > -20);
  } finally {
    await ctx.cleanup();
  }
});

test('endTime 超过时长时截到结尾；视频输入输出纯音频', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trimAudioOperation,
    { file: [video] },
    {
      startTime: 1,
      endTime: 100,
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.mp3');
    const data = result.data as { start: number; end: number | null; duration: number };
    assert.equal(data.end, null);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video, undefined);
    assertNear(info.duration, 1, 0.1, 'duration');
  } finally {
    await ctx.cleanup();
  }
});

test('音轨晚于画面开始：时间按音轨自身的开头计算', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trimAudioOperation,
    { file: [offsetVideo] },
    { startTime: 0, endTime: 2, format: 'wav' },
  );
  try {
    assert.deepEqual(result.data, { start: 0, end: 2, duration: 2 });
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 2, 0.05, 'duration');
    // 音轨开头的声音保留下来，1 秒之后是静音
    assert.ok(volumeOf(result.files[0], { start: 0.1, duration: 0.8 }).mean > -20);
    assert.ok(volumeOf(result.files[0], { start: 1.2, duration: 0.7 }).max < -60);
  } finally {
    await ctx.cleanup();
  }
});

test('startTime 超过音频时长时任务失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(trimAudioOperation, { file: [wav] }, { startTime: 5 }),
    /startTime（5 秒）超出了音频时长（3 秒）/,
  );
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(trimAudioOperation, {}), ['请提供 startTime、endTime 或 duration']);
  assert.deepEqual(paramErrors(trimAudioOperation, { endTime: 2, duration: 1 }), [
    'endTime 和 duration 只能提供其中一个',
  ]);
  assert.deepEqual(paramErrors(trimAudioOperation, { startTime: 3, endTime: 2 }), [
    'endTime 必须大于 startTime',
  ]);
  assert.deepEqual(paramErrors(trimAudioOperation, { duration: '0' }), ['duration 必须大于 0']);
  assert.match(
    paramErrors(trimAudioOperation, { startTime: '1:99' })[0],
    /startTime 必须是秒数或 HH:MM:SS 格式的时间/,
  );
  assert.deepEqual(paramErrors(trimAudioOperation, { startTime: '00:01:02.5' }), []);
});
