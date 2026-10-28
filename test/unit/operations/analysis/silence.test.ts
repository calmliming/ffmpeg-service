import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { extendTail, parseSilences, silence } from '../../../../src/operations/analysis/silence';
import type { Interval } from '../../../../src/operations/analysis/shared';
import { makeOffsetVideo, makePipedWebm } from '../audio/audio-helpers';
import { runExpectingError } from './helpers';

let dir = '';
let padded = '';
let video = '';
let noAudio = '';
let offsetVideo = '';
let noDuration = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-silence-');
  // 1 秒静音 + 1 秒正弦波 + 1 秒静音
  padded = makeAudio(dir, 'padded.wav', { duration: 1, silencePad: 1 });
  video = makeVideo(dir, 'video.mp4', { duration: 2 });
  noAudio = makeVideo(dir, 'mute.mp4', { duration: 1, audio: false });
  // 画面 6 秒；4 秒的音轨晚 1 秒开始、提前 1 秒结束：文件时间轴上 1-2.5 秒有声、2.5-4 秒静音、4-5 秒有声
  offsetVideo = makeOffsetVideo(dir, 'offset.mp4', {
    videoDuration: 6,
    audioExpr: 'if(between(t,1.5,3),0,0.5*sin(2*PI*440*t))',
    audioDuration: 4,
    offset: 1,
  });
  // 管道写出的 webm 没有时长信息：6 秒，2-4 秒静音
  noDuration = makePipedWebm(dir, 'nodur.weba', [
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))':d=6:s=48000",
    '-c:a',
    'libopus',
  ]);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface SilenceData {
  duration: number;
  count: number;
  totalSilence: number;
  silenceRatio: number;
  silences: Interval[];
  nonSilent: Interval[];
  truncated: boolean;
}

const near = (a: number, b: number, tolerance = 0.05) => Math.abs(a - b) <= tolerance;

test('silence：找到开头和结尾的静音，以及中间的有声片段', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(silence, { file: [padded] });
  try {
    assert.deepEqual(result.files, []);
    const data = result.data as SilenceData;
    assert.ok(near(data.duration, 3), `duration ${data.duration}`);
    assert.equal(data.count, 2);
    const [first, last] = data.silences;
    assert.ok(near(first.start, 0) && near(first.end, 1), JSON.stringify(first));
    assert.ok(near(last.start, 2) && near(last.end, 3), JSON.stringify(last));
    assert.ok(near(data.totalSilence, 2), `total ${data.totalSilence}`);
    assert.ok(near(data.silenceRatio, 2 / 3, 0.02));
    assert.equal(data.nonSilent.length, 1);
    assert.ok(near(data.nonSilent[0].start, 1) && near(data.nonSilent[0].end, 2));
    assert.equal(data.truncated, false);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('silence：minDuration 大于停顿时长时没有静音', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(silence, { file: [padded] }, { minDuration: '1.5' });
  try {
    const data = result.data as SilenceData;
    assert.equal(data.count, 0);
    assert.deepEqual(data.silences, []);
    assert.equal(data.totalSilence, 0);
    assert.equal(data.nonSilent.length, 1);
    assert.ok(near(data.nonSilent[0].end, 3));
  } finally {
    await ctx.cleanup();
  }
});

test('silence：noise 设到 0 dB 时整段都算静音', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(silence, { file: [video] }, { noise: 0 });
  try {
    const data = result.data as SilenceData;
    assert.equal(data.count, 1);
    assert.ok(near(data.totalSilence, 2, 0.1), `total ${data.totalSilence}`);
    assert.deepEqual(data.nonSilent, []);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'silence：音轨晚于画面开始、早于画面结束时，没有声音的头尾按静音计（文件时间轴）',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(silence, { file: [offsetVideo] });
    try {
      const data = result.data as SilenceData;
      assert.ok(near(data.duration, 6), `duration ${data.duration}`);
      const spans = (list: Interval[]) => list.map((i) => [i.start, i.end]);
      const close = (actual: number[][], expected: number[][]) =>
        actual.length === expected.length &&
        actual.every(([a, b], i) => near(a, expected[i][0], 0.06) && near(b, expected[i][1], 0.06));
      assert.ok(
        close(spans(data.silences), [
          [0, 1],
          [2.5, 4],
          [5, 6],
        ]),
        JSON.stringify(data.silences),
      );
      assert.ok(
        close(spans(data.nonSilent), [
          [1, 2.5],
          [4, 5],
        ]),
        JSON.stringify(data.nonSilent),
      );
      assert.ok(near(data.silenceRatio, 3.5 / 6, 0.02), `ratio ${data.silenceRatio}`);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('silence：没有时长信息的 webm 用实际解码长度收尾', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(silence, { file: [noDuration] });
  try {
    const data = result.data as SilenceData;
    assert.ok(near(data.duration, 6), `duration ${data.duration}`);
    assert.equal(data.count, 1);
    assert.ok(near(data.silences[0].start, 2) && near(data.silences[0].end, 4));
    assert.equal(data.nonSilent.length, 2, JSON.stringify(data.nonSilent));
    assert.ok(near(data.nonSilent[1].start, 4) && near(data.nonSilent[1].end, 6));
    assert.ok(near(data.silenceRatio, 1 / 3, 0.02), `ratio ${data.silenceRatio}`);
  } finally {
    await ctx.cleanup();
  }
});

test('silence：没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  const { error } = await runExpectingError(silence, { file: [noAudio] });
  assert.match(error.message, /没有音轨/);
});

test('silence：参数校验', () => {
  assert.deepEqual(paramErrors(silence, { noise: '10' }), ['noise 必须是 -90 到 0 之间的数字']);
  assert.deepEqual(paramErrors(silence, { minDuration: '0' }), [
    'minDuration 必须是 0.01 到 3600 之间的数字',
  ]);
  assert.deepEqual(paramErrors(silence, { noise: '-35', minDuration: '0.2' }), []);
});

test('silence：解析日志，结尾没有 silence_end 时用总时长收尾，忽略伪造的元数据行', () => {
  const stderr = [
    '    comment         : [Parsed_silencedetect_0 @ 0x1] silence_start: 0.5',
    '[Parsed_silencedetect_0 @ 0x2] silence_start: 1.25',
    '[Parsed_silencedetect_0 @ 0x2] silence_end: 2.5 | silence_duration: 1.25',
    '[Parsed_silencedetect_0 @ 0x2] silence_start: 9',
  ].join('\r\n');
  assert.deepEqual(parseSilences(stderr, 10), [
    { start: 1.25, end: 2.5, duration: 1.25 },
    { start: 9, end: 10, duration: 1 },
  ]);
});

test('silence：extendTail 把音轨结束后没有声音的部分并进静音', () => {
  const ending = [{ start: 3, end: 4.995, duration: 1.995 }];
  // 结尾静音一直延续到音轨结束（time= 只精确到 10 毫秒）：直接延长到文件结尾
  assert.deepEqual(extendTail(ending, 4.99, 6, 0.5), [{ start: 3, end: 6, duration: 3 }]);
  const sound = [{ start: 1, end: 2, duration: 1 }];
  // 音轨以声音结束：没有声音的尾巴单独算一段，同样要达到 minDuration
  assert.deepEqual(extendTail(sound, 5, 6, 0.5), [...sound, { start: 5, end: 6, duration: 1 }]);
  assert.deepEqual(extendTail(sound, 5.8, 6, 0.5), sound);
  // 音轨和文件一样长时不变
  assert.deepEqual(extendTail(sound, 6, 6, 0.5), sound);
});
