import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  loudness,
  parseEbur128Summary,
  parseVolumedetect,
} from '../../../../src/operations/analysis/loudness';
import { makePipedWebm } from '../audio/audio-helpers';
import { runExpectingError } from './helpers';

let dir = '';
let tone = '';
let video = '';
let silent = '';
let noAudio = '';
let short = '';
let noDuration = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-loudness-');
  tone = makeAudio(dir, 'tone.m4a', { duration: 3 });
  video = makeVideo(dir, 'video.mp4', { duration: 2 });
  noAudio = makeVideo(dir, 'mute.mp4', { duration: 1, audio: false });
  silent = `${dir}/silent.wav`;
  generate(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', silent]);
  // 0.3 秒、-18 dBFS 的音效：不够一个 400 毫秒的 EBU R128 测量块
  short = makeAudio(dir, 'short.wav', { duration: 0.3, channels: 1 });
  // 管道写出的 webm 没有时长信息（浏览器 MediaRecorder 录音常见）
  noDuration = makePipedWebm(dir, 'nodur.weba', [
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:a',
    'libopus',
  ]);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface LoudnessData {
  duration: number;
  integratedLufs: number | null;
  lraLu: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  thresholdLufs: number | null;
  silent: boolean;
  tooShort: boolean;
  target?: { targetLufs: number; gainDb: number | null; clipRisk: boolean };
  timeline?: { interval: number; points: { time: number; momentary: number; shortTerm: number }[] };
}

test('loudness：正弦波的综合响度、峰值和平均音量', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(loudness, { file: [tone] }, { target: '-14' });
  try {
    assert.deepEqual(result.files, []);
    const data = result.data as LoudnessData;
    assert.ok(Math.abs(data.duration - 3) < 0.1, `duration ${data.duration}`);
    // lavfi sine 默认振幅 1/8（-18 dBFS），升成双声道后约 -21 dBFS
    const integrated = data.integratedLufs ?? Number.NaN;
    assert.ok(integrated > -30 && integrated < -15, `I ${integrated}`);
    assert.ok(data.truePeakDbtp !== null && Math.abs(data.truePeakDbtp + 21) < 1.5);
    assert.ok(data.samplePeakDbfs !== null && data.maxVolumeDb !== null);
    assert.ok(Math.abs(data.samplePeakDbfs - data.maxVolumeDb) < 0.5);
    // 正弦波的有效值比峰值低 3 dB
    assert.ok(
      data.meanVolumeDb !== null && Math.abs(data.maxVolumeDb - data.meanVolumeDb - 3) < 0.6,
    );
    assert.equal(data.silent, false);
    assert.equal(data.target?.targetLufs, -14);
    assert.equal(data.tooShort, false);
    assert.ok(Math.abs((data.target?.gainDb ?? 0) - (-14 - integrated)) < 0.11);
    assert.equal(data.target?.clipRisk, false);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('loudness：timeline 返回每秒一个点的响度曲线', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(loudness, { file: [tone] }, { timeline: 'true' });
  try {
    const data = result.data as LoudnessData;
    assert.equal(data.timeline?.interval, 1);
    const points = data.timeline?.points ?? [];
    assert.deepEqual(
      points.map((p) => p.time),
      [0, 1, 2],
    );
    // 第一个点窗口里还没有声音，记为门限 -70；之后的瞬时响度接近综合响度
    assert.equal(points[0].momentary, -70);
    assert.ok(Math.abs(points[2].momentary - (data.integratedLufs ?? Number.NaN)) < 1.5);
    assert.ok(points.every((p) => p.shortTerm >= -70));
  } finally {
    await ctx.cleanup();
  }
});

test('loudness：视频文件分析音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(loudness, { file: [video] });
  try {
    const data = result.data as LoudnessData;
    const integrated = data.integratedLufs ?? Number.NaN;
    assert.ok(integrated > -40 && integrated < -10, `I ${integrated}`);
    assert.equal(data.target, undefined);
    assert.equal(data.timeline, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('loudness：全程静音', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(loudness, { file: [silent] }, { target: -16 });
  try {
    const data = result.data as LoudnessData;
    assert.equal(data.silent, true);
    assert.equal(data.tooShort, false);
    assert.equal(data.integratedLufs, -70);
    assert.equal(data.truePeakDbtp, null);
    assert.equal(data.thresholdLufs, null);
    assert.equal(data.lraLu, 0);
    assert.equal(data.target?.gainDb, null);
  } finally {
    await ctx.cleanup();
  }
});

test('loudness：短于 0.4 秒的响亮片段不算静音，综合响度为 null', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(loudness, { file: [short] }, { target: -14 });
  try {
    const data = result.data as LoudnessData;
    assert.equal(data.tooShort, true);
    assert.equal(data.silent, false);
    assert.equal(data.integratedLufs, null);
    assert.equal(data.thresholdLufs, null);
    assert.equal(data.lraLu, null);
    assert.ok(data.samplePeakDbfs !== null && Math.abs(data.samplePeakDbfs + 18) < 1);
    assert.ok(data.meanVolumeDb !== null && data.meanVolumeDb > -30);
    assert.equal(data.target?.gainDb, null);
    assert.equal(data.target?.clipRisk, false);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'loudness：没有时长信息的 webm 按实际解码长度返回 duration',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(loudness, { file: [noDuration] });
    try {
      const data = result.data as LoudnessData;
      assert.ok(Math.abs(data.duration - 3) < 0.1, `duration ${data.duration}`);
      assert.equal(data.silent, false);
      assert.equal(data.tooShort, false);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('loudness：没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  const { error, outputs } = await runExpectingError(loudness, { file: [noAudio] });
  assert.match(error.message, /没有音轨/);
  assert.deepEqual(outputs, []);
});

test('loudness：参数校验', () => {
  assert.deepEqual(paramErrors(loudness, { target: '-3' }), ['target 必须是 -70 到 -5 之间的数字']);
  assert.deepEqual(paramErrors(loudness, { timeline: 'maybe' }), [
    'timeline 必须是布尔值（true / false）',
  ]);
  assert.deepEqual(paramErrors(loudness, { target: '', timeline: '' }), []);
});

test('loudness：解析 ebur128 / volumedetect 日志，忽略伪造的元数据行', () => {
  const stderr = [
    '  Metadata:',
    '    title           : [Parsed_volumedetect_1 @ 0x1] max_volume: 0.0 dB',
    '[Parsed_ebur128_0 @ 0x55] Summary:',
    '',
    '  Integrated loudness:',
    '    I:         -23.4 LUFS',
    '    Threshold: -33.6 LUFS',
    '',
    '  Loudness range:',
    '    LRA:         5.2 LU',
    '    Threshold: -43.6 LUFS',
    '    LRA low:   -27.1 LUFS',
    '    LRA high:  -21.9 LUFS',
    '',
    '  Sample peak:',
    '    Peak:       -3.2 dBFS',
    '',
    '  True peak:',
    '    Peak:       -2.9 dBFS',
    '[Parsed_volumedetect_1 @ 0x56] mean_volume: -27.0 dB',
    '[Parsed_volumedetect_1 @ 0x56] max_volume: -3.2 dB',
  ].join('\n');
  assert.deepEqual(parseEbur128Summary(stderr), {
    integratedLufs: -23.4,
    thresholdLufs: -33.6,
    lraLu: 5.2,
    lraLowLufs: -27.1,
    lraHighLufs: -21.9,
    samplePeakDbfs: -3.2,
    truePeakDbtp: -2.9,
  });
  assert.deepEqual(parseVolumedetect(stderr), { meanVolumeDb: -27, maxVolumeDb: -3.2 });
  assert.equal(parseEbur128Summary('no summary here'), undefined);
});
