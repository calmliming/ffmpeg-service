import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mixAudio } from '../../../../src/operations/compositing/mix-audio';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { audioGaps, disguise, maxVolume, runFails, silences, streamsOf } from './fixtures';

let dir = '';
let video = '';
let video5 = '';
let silent = '';
let short = '';
let long = '';
let toneM4a = '';
let toneMp3 = '';
let webm = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-mix-');
  video = disguise(makeVideo(dir, 'v.mp4', { duration: 2 }));
  video5 = makeVideo(dir, 'v5.mp4', { size: '160x120', duration: 5 });
  silent = makeVideo(dir, 'silent.mp4', { duration: 2, audio: false });
  short = disguise(makeAudio(dir, 'short.mp3', { duration: 1, freq: 880 }));
  long = makeAudio(dir, 'long.wav', { duration: 5, freq: 660 });
  // 连续的正弦波：循环接缝处只要有一点静音或空洞都能检测出来
  toneM4a = disguise(makeAudio(dir, 'tone.m4a', { duration: 1, freq: 330 }));
  toneMp3 = makeAudio(dir, 'tone.mp3', { duration: 1, freq: 330 });
  // VP8 + Vorbis、奇数尺寸：画面和音频都不能直接流复制进 mp4
  webm = path.join(dir, 'odd.webm');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=321x241:rate=25:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v',
    'libvpx',
    '-b:v',
    '300k',
    '-c:a',
    'libvorbis',
    '-shortest',
    webm,
  ]);
  webm = disguise(webm);
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

const SILENT_DB = -60;
const LOUD_DB = -30;

test(
  'mix：输出时长等于视频，画面流复制，音频 AAC 48 kHz 立体声',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      mixAudio,
      { file: [video], audio: [long] },
      { volume: '0.5', originalVolume: '0.8' },
    );
    try {
      assert.equal(result.files.length, 1);
      const out = result.files[0];
      assert.ok(out.endsWith('.mp4'));
      const media = await probeMedia(out);
      assert.ok(Math.abs(media.duration - 2) < 0.1, `时长 ${media.duration}`);
      assert.equal(media.audio?.codec, 'aac');
      assert.equal(media.audio?.sampleRate, 48000);
      assert.equal(media.audio?.channels, 2);
      const v = (await streamsOf(out)).find((s) => s.codec_type === 'video');
      assert.equal(v?.codec_name, 'h264');
      assert.equal(v?.nb_frames, '50', '画面应当流复制');
      assert.ok(maxVolume(out, 0.5, 1) > LOUD_DB);
      assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('replace：短音频不循环时之后是静音', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    mixAudio,
    { file: [video], audio: [short] },
    { mode: 'replace' },
  );
  try {
    const out = result.files[0];
    const media = await probeMedia(out);
    assert.ok(Math.abs(media.duration - 2) < 0.1, `时长 ${media.duration}`);
    assert.ok(maxVolume(out, 0.2, 0.5) > LOUD_DB, '前 1 秒是加入的音频');
    assert.ok(maxVolume(out, 1.3, 0.6) < SILENT_DB, '原声被替换，1 秒后应当静音');
  } finally {
    await ctx.cleanup();
  }
});

test('replace + loop：短音频循环到视频结束', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    mixAudio,
    { file: [video], audio: [short] },
    { mode: 'replace', loop: 'true' },
  );
  try {
    const out = result.files[0];
    const media = await probeMedia(out);
    assert.ok(Math.abs(media.duration - 2) < 0.1, `时长 ${media.duration}`);
    assert.ok(maxVolume(out, 1.3, 0.6) > LOUD_DB, '循环后 1 秒之后仍有声音');
  } finally {
    await ctx.cleanup();
  }
});

test('offset 延后开始，fadeOut 在结尾淡出', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    mixAudio,
    { file: [video], audio: [long] },
    { mode: 'replace', offset: '00:00:01', fadeOut: 0.5 },
  );
  try {
    const out = result.files[0];
    assert.ok(maxVolume(out, 0.1, 0.7) < SILENT_DB, '前 1 秒还没开始');
    assert.ok(maxVolume(out, 1.1, 0.3) > LOUD_DB, '1 秒后开始');
    assert.ok(maxVolume(out, 1.9, 0.1) < maxVolume(out, 1.1, 0.3) - 6, '结尾应当淡出');
  } finally {
    await ctx.cleanup();
  }
});

test('视频没有音轨：mix 只输出加入的音频', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(mixAudio, { file: [silent], audio: [short] }, {});
  try {
    const out = result.files[0];
    const media = await probeMedia(out);
    assert.equal(media.audio?.codec, 'aac');
    assert.ok(Math.abs(media.duration - 2) < 0.1, `时长 ${media.duration}`);
    assert.ok(maxVolume(out, 0.2, 0.5) > LOUD_DB);
    assert.ok(ctx.logs.some((l) => l.includes('视频没有音轨')));
  } finally {
    await ctx.cleanup();
  }
});

test('ducking + audioStart + fadeIn 组合可以运行', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    mixAudio,
    { file: [video], audio: [long] },
    { ducking: true, audioStart: 1.5, fadeIn: 0.5, volume: 2 },
  );
  try {
    const media = await probeMedia(result.files[0]);
    assert.ok(Math.abs(media.duration - 2) < 0.1, `时长 ${media.duration}`);
    // alimiter 限幅，音量 2 倍也不会削波
    assert.ok(maxVolume(result.files[0], 0, 2) <= 0);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'audioStart > 0 时 offset 仍然生效：mix 模式前 offset 秒没有音乐',
  { skip: ffmpegSkip },
  async () => {
    // 回归：adelay 在 atrim 丢弃 audioStart 秒期间就发出了补的静音（时间戳无效），音乐被提前到 0 秒
    const { result, ctx } = await runOperation(
      mixAudio,
      { file: [video], audio: [long] },
      { originalVolume: 0, offset: 1, audioStart: 1.5 },
    );
    try {
      const out = result.files[0];
      assert.ok(maxVolume(out, 0.1, 0.7) < SILENT_DB, '前 1 秒还没开始');
      assert.ok(maxVolume(out, 1.2, 0.6) > LOUD_DB, '1 秒后开始');
      assert.deepEqual(audioGaps(out), []);
    } finally {
      await ctx.cleanup();
    }
  },
);

test(
  'audioStart + offset、视频没有音轨：音轨从 0 秒连续，没有时间戳空洞',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      mixAudio,
      { file: [silent], audio: [long] },
      { offset: 0.5, audioStart: 2 },
    );
    try {
      const out = result.files[0];
      assert.deepEqual(audioGaps(out), [], '前 0.5 秒应当是真正的静音数据，而不是空洞');
      assert.ok(maxVolume(out, 0.05, 0.35) < SILENT_DB, '前 0.5 秒静音');
      assert.ok(maxVolume(out, 0.7, 1) > LOUD_DB, '0.5 秒后是加入的音频');
      const media = await probeMedia(out);
      assert.ok(Math.abs((media.audio?.duration ?? 0) - 2) < 0.05, `音轨 ${media.audio?.duration}`);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('loop：循环无缝，接缝处没有静音和时间戳空洞', { skip: ffmpegSkip }, async () => {
  // 回归：压缩音频直接 -stream_loop，每一遍多出编码延迟和补齐的时长，接缝处留下 20-45 ms 的空洞 / 静音
  const cases = [
    { audio: toneM4a, format: 'm4a', mode: 'replace' },
    { audio: toneM4a, format: 'm4a', mode: 'mix' },
    { audio: toneMp3, format: 'mp3', mode: 'replace' },
  ];
  for (const c of cases) {
    const label = `${c.format} ${c.mode}`;
    const { result, ctx } = await runOperation(
      mixAudio,
      { file: [video5], audio: [c.audio] },
      { mode: c.mode, loop: true, originalVolume: 0 },
    );
    try {
      const out = result.files[0];
      assert.deepEqual(audioGaps(out), [], `${label} 时间戳空洞`);
      const gaps = silences(out).filter((s) => s.start < 4.95);
      assert.deepEqual(gaps, [], `${label} 接缝处的静音`);
      assert.ok(maxVolume(out, 4.6, 0.3) > LOUD_DB, `${label} 一直循环到视频结尾`);
      const media = await probeMedia(out);
      assert.ok(Math.abs(media.duration - 5) < 0.1, `${label} 时长 ${media.duration}`);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('VP8 / Vorbis、奇数尺寸的视频转成 H.264 偶数尺寸', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(mixAudio, { file: [webm], audio: [short] }, {});
  try {
    const media = await probeMedia(result.files[0]);
    assert.equal(media.video?.codec, 'h264');
    assert.equal(media.video?.width, 320);
    assert.equal(media.video?.height, 240);
    assert.equal(media.audio?.codec, 'aac');
  } finally {
    await ctx.cleanup();
  }
});

test('offset 不小于视频时长时任务失败', { skip: ffmpegSkip }, async () => {
  await runFails(
    mixAudio,
    { file: [video], audio: [short] },
    { offset: 3 },
    /offset（3 秒）不小于视频时长/,
  );
});

test('audioStart 超出音频时长时任务失败', { skip: ffmpegSkip }, async () => {
  await runFails(
    mixAudio,
    { file: [video], audio: [short] },
    { audioStart: 5 },
    /audioStart（5 秒）超出了音频时长/,
  );
});

test('加入的文件没有音轨、输入不是视频时任务失败', { skip: ffmpegSkip }, async () => {
  await runFails(mixAudio, { file: [video], audio: [silent] }, {}, /加入的音频文件不包含音频/);
  await runFails(mixAudio, { file: [long], audio: [short] }, {}, /输入文件不包含视频画面/);
});

test('参数校验', () => {
  const provided = { file: 1, audio: 1 };
  assert.deepEqual(paramErrors(mixAudio, { volume: '4' }, provided), [
    'volume 必须是 0 到 3 之间的数字',
  ]);
  assert.deepEqual(paramErrors(mixAudio, { originalVolume: '-1' }, provided), [
    'originalVolume 必须是 0 到 3 之间的数字',
  ]);
  assert.deepEqual(paramErrors(mixAudio, { mode: 'add' }, provided), ['mode 只能是 mix / replace']);
  assert.deepEqual(paramErrors(mixAudio, { offset: 'abc' }, provided), [
    'offset 必须是秒数或 HH:MM:SS 格式的时间',
  ]);
  assert.deepEqual(paramErrors(mixAudio, { offset: '90000' }, provided), [
    'offset 不能超过 24 小时',
  ]);
  assert.deepEqual(paramErrors(mixAudio, { fadeIn: '61' }, provided), [
    'fadeIn 必须是 0 到 60 之间的数字',
  ]);
  assert.deepEqual(paramErrors(mixAudio, { loop: 'maybe' }, provided), [
    'loop 必须是布尔值（true / false）',
  ]);
  assert.deepEqual(
    paramErrors(mixAudio, { offset: '1:02.5', loop: '1', ducking: 'on', volume: '' }, provided),
    [],
  );
  const parsed = mixAudio.params.parse({ offset: '1:02.5' });
  assert.equal(parsed.offset, 62.5);
  assert.equal(parsed.volume, 1);
});
