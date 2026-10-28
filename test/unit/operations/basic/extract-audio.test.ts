import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractAudio } from '../../../../src/operations/basic/extract-audio';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertInside, assertNear, expectRunError, extOf, facts } from './helpers';

let dir = '';
let video = '';
let silent = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-basic-extract-');
  video = makeVideo(dir, 'in.mp4');
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('extract-audio: 默认输出 mp3，不含画面', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(extractAudio, { file: [video] });
  try {
    const [out] = result.files;
    assertInside(ctx.outputRoot, out);
    assert.equal(extOf(out), 'mp3');
    const f = await facts(out);
    assert.equal(f.video, undefined);
    assert.equal(f.audio?.codec, 'mp3');
    assertNear(f.duration, 2, 0.15);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('extract-audio: 各种格式对应的编码', { skip: ffmpegSkip }, async () => {
  const cases: [string, string, string][] = [
    ['aac', 'aac', 'aac'],
    ['m4a', 'm4a', 'aac'],
    ['wav', 'wav', 'pcm_s16le'],
    ['FLAC', 'flac', 'flac'],
    ['ogg', 'ogg', 'vorbis'],
    ['opus', 'opus', 'opus'],
  ];
  for (const [format, ext, codec] of cases) {
    const { result, ctx } = await runOperation(extractAudio, { file: [video] }, { format });
    try {
      assert.equal(extOf(result.files[0]), ext);
      const f = await facts(result.files[0]);
      assert.equal(f.video, undefined);
      assert.equal(f.audio?.codec, codec, format);
      assertNear(f.duration, 2, 0.15);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('extract-audio: 采样率、声道、码率', { skip: ffmpegSkip }, async () => {
  const wav = await runOperation(
    extractAudio,
    { file: [video] },
    { format: 'wav', sampleRate: '16000', channels: '1' },
  );
  const mp3 = await runOperation(extractAudio, { file: [video] }, { bitrate: '96k' });
  try {
    const w = await facts(wav.result.files[0]);
    assert.equal(w.audio?.sampleRate, 16000);
    assert.equal(w.audio?.channels, 1);
    const m = await facts(mp3.result.files[0]);
    assertNear(m.audio?.bitRate ?? 0, 96000, 2000, '码率');
  } finally {
    await wav.ctx.cleanup();
    await mp3.ctx.cleanup();
  }
});

test('extract-audio: copy=true 不重新编码直接取出 AAC', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    extractAudio,
    { file: [video] },
    { format: 'm4a', copy: 'true' },
  );
  try {
    const f = await facts(result.files[0]);
    assert.equal(f.audio?.codec, 'aac');
    assert.equal(f.audio?.sampleRate, 48000, '复制不会改采样率');
  } finally {
    await ctx.cleanup();
  }
});

test('extract-audio: track 选择第二路音轨', { skip: ffmpegSkip }, async () => {
  const dual = path.join(dir, 'dual.mkv');
  generate([
    '-i',
    video,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=22050:duration=2',
    '-map',
    '0:v',
    '-map',
    '0:a',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    '-c:a',
    'flac',
    dual,
  ]);
  const { result, ctx } = await runOperation(
    extractAudio,
    { file: [dual] },
    { format: 'flac', track: '1', copy: true },
  );
  try {
    const f = await facts(result.files[0]);
    assert.equal(f.audio?.codec, 'flac');
    assert.equal(f.audio?.sampleRate, 22050, '应当是第二路（22050 Hz）');
    assert.equal(f.streams.length, 1);
  } finally {
    await ctx.cleanup();
  }
  await expectRunError(
    extractAudio,
    { file: [dual] },
    { track: 2 },
    /输入文件只有 2 路音轨，track 最大为 1/,
  );
});

test('extract-audio: 纯音频输入也能转换', { skip: ffmpegSkip }, async () => {
  const wav = makeAudio(dir, 'tone.wav', { duration: 1 });
  const { result, ctx } = await runOperation(extractAudio, { file: [wav] }, { format: 'opus' });
  try {
    const f = await facts(result.files[0]);
    assert.equal(f.audio?.codec, 'opus');
    assertNear(f.duration, 1, 0.1);
  } finally {
    await ctx.cleanup();
  }
});

test('extract-audio: 没有音轨、copy 编码不匹配时给出中文错误', { skip: ffmpegSkip }, async () => {
  await expectRunError(extractAudio, { file: [silent] }, {}, /^Error: 输入文件没有音轨$/);
  await expectRunError(
    extractAudio,
    { file: [video] },
    { format: 'mp3', copy: true },
    /源音频编码是 aac，不能直接复制为 mp3/,
  );
});

test('extract-audio: 参数校验', () => {
  const one = (raw: Record<string, unknown>) => paramErrors(extractAudio, raw).join(' | ');
  assert.match(
    one({ format: 'mp4' }),
    /format 只能是 mp3 \/ m4a \/ aac \/ wav \/ flac \/ ogg \/ opus/,
  );
  assert.match(one({ format: '../x' }), /format 只能是/);
  assert.match(one({ bitrate: '500k' }), /mp3 编码的 bitrate 必须在 8k 到 320k 之间/);
  assert.match(one({ bitrate: 'loud' }), /bitrate 必须是码率/);
  assert.match(one({ format: 'opus', sampleRate: 44100 }), /opus 编码只支持采样率/);
  assert.match(one({ sampleRate: 1000 }), /sampleRate 必须是 8000 到 192000 之间的整数/);
  assert.match(one({ channels: 3 }), /channels 必须是 1 到 2 之间的整数/);
  assert.match(one({ track: -1 }), /track 必须是 0 到 63 之间的整数/);
  assert.match(
    one({ copy: true, bitrate: '128k' }),
    /copy=true 直接复制音频流，不能同时设置 bitrate/,
  );
  assert.deepEqual(
    paramErrors(extractAudio, { format: 'wav', bitrate: '128k' }),
    [],
    '无损格式忽略码率',
  );
  assert.deepEqual(
    paramErrors(extractAudio, { format: 'mp3', bitrate: '128' }),
    [],
    '裸数字按 kbps',
  );
});
