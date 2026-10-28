import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { convertOperation } from '../../../../src/operations/audio/convert';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, volumeOf, withoutExtension } from './audio-helpers';

let dir = '';
let wav = '';
let m4a = '';
let video = '';
let silentVideo = '';
let flacNoExt = '';
let opus = '';
let mono = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-convert-');
  wav = makeAudio(dir, 'tone.wav', { duration: 2 });
  m4a = makeAudio(dir, 'tone.m4a', { duration: 2 });
  opus = makeAudio(dir, 'tone.opus', { duration: 1, sampleRate: 48000 });
  video = makeVideo(dir, 'clip.mp4', { duration: 2 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
  flacNoExt = withoutExtension(makeAudio(dir, 'tone.flac', { duration: 1 }));
  mono = makeAudio(dir, 'mono.wav', { duration: 1, channels: 1 });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('wav 转 mp3，可指定码率、采样率和声道', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    convertOperation,
    { file: [wav] },
    {
      format: 'mp3',
      bitrate: '128k',
      sampleRate: '22050',
      channels: '1',
    },
  );
  try {
    assert.equal(result.files.length, 1);
    assert.equal(path.extname(result.files[0]), '.mp3');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.codec, 'mp3');
    assert.equal(info.audio?.sampleRate, 22050);
    assert.equal(info.audio?.channels, 1);
    assertNear(info.duration, 2, 0.1, 'duration');
    assert.deepEqual(result.data, { format: 'mp3', codec: 'mp3', copied: false });
    assert.ok(ctx.progressCalls.length > 0);
  } finally {
    await ctx.cleanup();
  }
});

test('不传 format 时沿用输入格式，编码相同直接复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(convertOperation, { file: [m4a] }, {});
  try {
    assert.equal(path.extname(result.files[0]), '.m4a');
    assert.deepEqual(result.data, { format: 'm4a', codec: 'aac', copied: true });
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.codec, 'aac');
    assert.equal(info.video, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('没有扩展名的输入按内容识别格式（URL 下载的文件名不可信）', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    convertOperation,
    { file: [flacNoExt] },
    {
      sampleRate: 48000,
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.flac');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.codec, 'flac');
    assert.equal(info.audio?.sampleRate, 48000);
  } finally {
    await ctx.cleanup();
  }
});

test('视频输入：默认输出 mp3，指定 m4a 时直接复制 AAC 音轨', { skip: ffmpegSkip }, async () => {
  const first = await runOperation(convertOperation, { file: [video] }, {});
  try {
    assert.equal(path.extname(first.result.files[0]), '.mp3');
    const info = await probeMedia(first.result.files[0]);
    assert.equal(info.video, undefined);
    assertNear(info.duration, 2, 0.15, 'duration');
  } finally {
    await first.ctx.cleanup();
  }

  const second = await runOperation(convertOperation, { file: [video] }, { format: 'm4a' });
  try {
    assert.equal((second.result.data as { copied: boolean }).copied, true);
    const info = await probeMedia(second.result.files[0]);
    assert.equal(info.video, undefined);
    assert.equal(info.audio?.codec, 'aac');
  } finally {
    await second.ctx.cleanup();
  }
});

test('转 opus、ogg、aac、wav 都能输出', { skip: ffmpegSkip }, async () => {
  const expected = { opus: 'opus', ogg: 'vorbis', aac: 'aac', wav: 'pcm_s16le' } as const;
  for (const [format, codec] of Object.entries(expected)) {
    const { result, ctx } = await runOperation(convertOperation, { file: [wav] }, { format });
    try {
      const info = await probeMedia(result.files[0]);
      assert.equal(info.audio?.codec, codec, format);
      assertNear(info.duration, 2, 0.15, format);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('单声道转立体声时两个声道音量与原文件相同', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    convertOperation,
    { file: [mono] },
    {
      format: 'flac',
      channels: 2,
    },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio?.channels, 2);
    assertNear(volumeOf(result.files[0]).mean, volumeOf(mono).mean, 0.2, 'mean');
  } finally {
    await ctx.cleanup();
  }
});

test('没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(convertOperation, { file: [silentVideo] }, {}),
    /输入文件没有音轨/,
  );
});

test('沿用的格式不支持指定的采样率时任务失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(convertOperation, { file: [opus] }, { sampleRate: 44100 }),
    /opus 格式不支持 44100 Hz 采样率/,
  );
});

test('参数校验', () => {
  assert.match(paramErrors(convertOperation, { format: 'wma' })[0], /format 只能是 mp3/);
  assert.match(paramErrors(convertOperation, { sampleRate: 12345 })[0], /sampleRate 只能是 8000/);
  assert.match(
    paramErrors(convertOperation, { channels: 3 })[0],
    /channels 必须是 1 到 2 之间的整数/,
  );
  assert.match(paramErrors(convertOperation, { bitrate: 'fast' })[0], /bitrate 必须是 8k 到 512k/);
  assert.match(
    paramErrors(convertOperation, { format: 'mp3', sampleRate: 96000 })[0],
    /mp3 格式不支持 96000 Hz/,
  );
  assert.deepEqual(
    paramErrors(convertOperation, { format: 'MP3', bitrate: '', sampleRate: '' }),
    [],
  );
});
