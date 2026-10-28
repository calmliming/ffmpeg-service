import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cutFilter,
  keepRanges,
  parseSilences,
  trimSilenceOperation,
} from '../../../../src/operations/audio/trim-silence';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  assertNear,
  makeExprAudio,
  makeOffsetVideo,
  volumeOf,
  withoutExtension,
} from './audio-helpers';

interface TrimSilenceData {
  originalDuration: number;
  duration: number;
  removed: number;
  silences: number;
  segments: number;
}

let dir = '';
let padded = '';
let gappy = '';
let silence = '';
let noSilence = '';
let video = '';
let offsetVideo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-trimsilence-');
  // 1 秒静音 + 2 秒正弦 + 1 秒静音
  padded = makeAudio(dir, 'padded.wav', { duration: 2, silencePad: 1 });
  // 0.5 秒静音、1 秒声音、1.5 秒静音（中间）、1 秒声音
  gappy = withoutExtension(
    makeExprAudio(dir, 'gappy.flac', 'if(lt(t,0.5)+between(t,1.5,3),0,0.5*sin(2*PI*440*t))', 4),
  );
  silence = makeExprAudio(dir, 'silence.wav', '0', 1);
  noSilence = makeAudio(dir, 'tone.mp3', { duration: 2 });
  video = makeVideo(dir, 'clip.mp4', { duration: 2 });
  // 画面 8 秒；音轨晚 0.5 秒开始：2 秒静音、2 秒声音、1.5 秒静音、2 秒声音
  offsetVideo = makeOffsetVideo(dir, 'offset.mp4', {
    videoDuration: 8,
    audioExpr: 'if(lt(t,2)+between(t,4,5.5),0,0.5*sin(2*PI*440*t))',
    audioDuration: 7.5,
    offset: 0.5,
  });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('默认去掉开头和结尾的静音', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(trimSilenceOperation, { file: [padded] }, {});
  try {
    assert.equal(path.extname(result.files[0]), '.wav');
    const data = result.data as TrimSilenceData;
    assertNear(data.originalDuration, 4, 0.01, 'originalDuration');
    assertNear(data.duration, 2, 0.05, 'duration');
    assertNear(data.removed, 2, 0.05, 'removed');
    assert.equal(data.silences, 2);
    assert.equal(data.segments, 1);
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 2, 0.05, 'probe duration');
    // 开头就是声音
    assert.ok(volumeOf(result.files[0], { start: 0, duration: 0.1 }).mean > -30);
    const phases = ctx.progressCalls.map((c) => c.extra?.phase).filter(Boolean);
    assert.deepEqual(phases, ['analyzing', 'processing']);
  } finally {
    await ctx.cleanup();
  }
});

test('where=start / end 只去一头，padding 保留一点静音', { skip: ffmpegSkip }, async () => {
  const start = await runOperation(trimSilenceOperation, { file: [padded] }, { where: 'start' });
  try {
    assertNear((start.result.data as TrimSilenceData).duration, 3, 0.05, 'start');
  } finally {
    await start.ctx.cleanup();
  }
  const end = await runOperation(
    trimSilenceOperation,
    { file: [padded] },
    {
      where: 'end',
      padding: '0.25',
    },
  );
  try {
    assertNear((end.result.data as TrimSilenceData).duration, 3.25, 0.05, 'end + padding');
    const info = await probeMedia(end.result.files[0]);
    assertNear(info.duration, 3.25, 0.05, 'probe');
  } finally {
    await end.ctx.cleanup();
  }
});

test(
  'where=all 把中间过长的停顿缩短到 maxGap（输入没有扩展名，按内容沿用 flac）',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      trimSilenceOperation,
      { file: [gappy] },
      {
        where: 'all',
        maxGap: '0.4',
      },
    );
    try {
      assert.equal(path.extname(result.files[0]), '.flac');
      const data = result.data as TrimSilenceData;
      // 开头 0.5 秒去掉，中间 1.5 秒缩到 0.4 秒：4 - 0.5 - 1.1 = 2.4
      assertNear(data.duration, 2.4, 0.05, 'duration');
      assert.equal(data.segments, 2);
      const info = await probeMedia(result.files[0]);
      assertNear(info.duration, 2.4, 0.05, 'probe');
      // 1.0-1.4 秒是缩短后的停顿
      assert.ok(volumeOf(result.files[0], { start: 1.05, duration: 0.3 }).max < -60);
      assert.ok(volumeOf(result.files[0], { start: 1.5, duration: 0.3 }).mean > -20);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('没有静音时照常输出；视频输入输出纯音频', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(trimSilenceOperation, { file: [noSilence] }, {});
  try {
    assert.equal(path.extname(result.files[0]), '.mp3');
    const data = result.data as TrimSilenceData;
    assert.equal(data.removed, 0);
    assert.equal(data.silences, 0);
  } finally {
    await ctx.cleanup();
  }
  const fromVideo = await runOperation(trimSilenceOperation, { file: [video] }, {});
  try {
    const info = await probeMedia(fromVideo.result.files[0]);
    assert.equal(info.video, undefined);
    assert.ok(info.audio);
  } finally {
    await fromVideo.ctx.cleanup();
  }
});

test('音轨晚于画面开始：开头的静音照样去掉，时长按音轨计算', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trimSilenceOperation,
    { file: [offsetVideo] },
    { format: 'wav' },
  );
  try {
    const data = result.data as TrimSilenceData;
    // AAC 编码会在音轨开头多出约 21 ms 的编码延迟
    assertNear(data.originalDuration, 7.5, 0.1, 'originalDuration');
    assertNear(data.removed, 2, 0.1, 'removed');
    assertNear(data.duration, 5.5, 0.1, 'duration');
    assert.equal(data.segments, 1);
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 5.5, 0.1, 'probe duration');
    // 开头就是声音
    assert.ok(volumeOf(result.files[0], { start: 0.05, duration: 0.1 }).mean > -20);
  } finally {
    await ctx.cleanup();
  }
});

test('整段静音时任务失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(trimSilenceOperation, { file: [silence] }, {}),
    /整段音频都低于 -50 dB/,
  );
});

test('parseSilences 补齐结尾没有 end 的静音，keepRanges 计算保留区间', () => {
  const stderr = [
    '[silencedetect @ 0] silence_start: 0',
    '[silencedetect @ 0] silence_end: 0.5 | silence_duration: 0.5',
    '[silencedetect @ 0] silence_start: 1.5',
    '[silencedetect @ 0] silence_end: 3 | silence_duration: 1.5',
    '[silencedetect @ 0] silence_start: 3.8',
  ].join('\n');
  const silences = parseSilences(stderr, 4);
  assert.deepEqual(silences, [
    { start: 0, end: 0.5 },
    { start: 1.5, end: 3 },
    { start: 3.8, end: 4 },
  ]);
  const opts = { maxGap: 0.4, padding: 0 };
  assert.deepEqual(keepRanges(silences, 4, { ...opts, where: 'both' }), [[0.5, 3.8]]);
  assert.deepEqual(keepRanges(silences, 4, { ...opts, where: 'start' }), [[0.5, 4]]);
  assert.deepEqual(keepRanges(silences, 4, { ...opts, where: 'end' }), [[0, 3.8]]);
  const all = keepRanges(silences, 4, { ...opts, where: 'all' });
  assert.equal(all.length, 2);
  assertNear(all[0][0], 0.5, 1e-9, 'all[0][0]');
  assertNear(all[0][1], 1.7, 1e-9, 'all[0][1]');
  assertNear(all[1][0], 2.8, 1e-9, 'all[1][0]');
  assertNear(all[1][1], 3.8, 1e-9, 'all[1][1]');
  // 中间停顿不超过 maxGap 时不动
  assert.equal(keepRanges(silences, 4, { maxGap: 2, padding: 0, where: 'all' }).length, 1);
  // 整段静音
  assert.deepEqual(keepRanges([{ start: 0, end: 4 }], 4, { ...opts, where: 'both' }), []);
});

test('cutFilter：一段用 atrim，多段用 aselect，只含数字', () => {
  assert.equal(cutFilter([[0, 4]], 4, 44100), 'anull');
  assert.equal(cutFilter([[0.5, 3.8]], 4, 44100), 'atrim=start=0.5:end=3.8,asetpts=PTS-STARTPTS');
  assert.equal(
    cutFilter(
      [
        [0.5, 1.7],
        [2.8, 4],
      ],
      4,
      44100,
    ),
    "asetnsamples=n=221:p=0,aselect='between(t,0.5,1.7)+gte(t,2.8)',asetpts=N/SR/TB",
  );
});

test('参数校验', () => {
  assert.match(
    paramErrors(trimSilenceOperation, { threshold: -5 })[0],
    /threshold 必须是 -90 到 -10 之间的数字/,
  );
  assert.match(
    paramErrors(trimSilenceOperation, { minSilence: 0 })[0],
    /minSilence 必须是 0.05 到 60 之间的数字/,
  );
  assert.match(
    paramErrors(trimSilenceOperation, { where: 'middle' })[0],
    /where 只能是 start \/ end \/ both \/ all/,
  );
  assert.match(
    paramErrors(trimSilenceOperation, { maxGap: 11 })[0],
    /maxGap 必须是 0 到 10 之间的数字/,
  );
  assert.deepEqual(
    paramErrors(trimSilenceOperation, { threshold: '-40', where: 'ALL', maxGap: '0' }),
    [],
  );
});
