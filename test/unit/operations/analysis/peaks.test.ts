import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  computePeaks,
  peaks,
  pickSampleRate,
  toPeakPairs,
} from '../../../../src/operations/analysis/peaks';
import { runExpectingError } from './helpers';

let dir = '';
let tone = '';
let padded = '';
let mono = '';
let video = '';
let noAudio = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-peaks-');
  tone = makeAudio(dir, 'tone.mp3', { duration: 2 });
  padded = makeAudio(dir, 'padded.wav', { duration: 1, silencePad: 1 });
  mono = makeAudio(dir, 'mono.flac', { duration: 1, channels: 1 });
  video = makeVideo(dir, 'video.mp4', { duration: 2 });
  noAudio = makeVideo(dir, 'mute.mp4', { duration: 1, audio: false });
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface PeaksData {
  duration: number;
  sampleRate: number;
  sourceSampleRate: number;
  sourceChannels: number;
  points: number;
  channels: number;
  mode: string;
  normalized: boolean;
  peaks?: number[][] | number[][][];
}

const extremes = (pairs: number[][]) => ({
  min: Math.min(...pairs.map((p) => p[0])),
  max: Math.max(...pairs.map((p) => p[1])),
});

test(
  'peaks：mono 模式返回 [min, max] 对，数值在 -1..1、4 位小数',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(peaks, { file: [tone] }, { points: '200' });
    try {
      assert.deepEqual(result.files, []);
      const data = result.data as PeaksData;
      assert.equal(data.points, 200);
      assert.equal(data.channels, 1);
      assert.equal(data.sourceChannels, 2);
      assert.equal(data.sampleRate, 8000);
      assert.equal(data.sourceSampleRate, 44100);
      assert.ok(Math.abs(data.duration - 2) < 0.1, `duration ${data.duration}`);
      const pairs = data.peaks as number[][];
      assert.equal(pairs.length, 200);
      assert.ok(pairs.every((p) => p.length === 2 && p[0] <= p[1] && p[0] >= -1 && p[1] <= 1));
      assert.ok(pairs.flat().every((v) => Number(v.toFixed(4)) === v));
      // lavfi sine 振幅 1/8，升双声道后每声道约 0.088
      const { min, max } = extremes(pairs);
      assert.ok(Math.abs(max - 0.088) < 0.01, `max ${max}`);
      assert.ok(Math.abs(min + 0.088) < 0.01, `min ${min}`);
      const fractions = ctx.progressCalls.map((c) => c.fraction);
      assert.ok(
        fractions.every((f, i) => i === 0 || f >= fractions[i - 1]),
        '进度应单调增长',
      );
      assert.equal(fractions.at(-1), 1);
      // 中间 PCM 文件用完即删
      assert.equal(fs.existsSync(ctx.tempPath('peaks.raw')), false);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('peaks：静音段的峰值为 0，normalize 放大到 ±1', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    peaks,
    { file: [padded] },
    { points: 300, normalize: 'true' },
  );
  try {
    const data = result.data as PeaksData;
    assert.equal(data.normalized, true);
    const pairs = data.peaks as number[][];
    assert.equal(pairs.length, 300);
    // 前 1 秒和后 1 秒是静音（留出重采样在边界上的余量）
    const head = extremes(pairs.slice(0, 95));
    const tail = extremes(pairs.slice(205));
    assert.ok(head.max <= 0.001 && head.min >= -0.001, JSON.stringify(head));
    assert.ok(tail.max <= 0.001 && tail.min >= -0.001, JSON.stringify(tail));
    const middle = extremes(pairs.slice(105, 195));
    assert.ok(middle.max > 0.99 || middle.min < -0.99, JSON.stringify(middle));
  } finally {
    await ctx.cleanup();
  }
});

test('peaks：split 模式每个声道一条，视频文件也能用', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    peaks,
    { file: [video] },
    { points: 100, channels: 'split' },
  );
  try {
    const data = result.data as PeaksData;
    assert.equal(data.mode, 'split');
    assert.equal(data.channels, 2);
    const channels = data.peaks as number[][][];
    assert.equal(channels.length, 2);
    assert.ok(channels.every((c) => c.length === 100));
  } finally {
    await ctx.cleanup();
  }

  const single = await runOperation(peaks, { file: [mono] }, { channels: 'split' });
  try {
    const data = single.result.data as PeaksData;
    assert.equal(data.channels, 1);
    assert.equal((data.peaks as number[][][]).length, 1);
  } finally {
    await single.ctx.cleanup();
  }
});

test(
  'peaks：output=file 时峰值写进 JSON 产物，任务结果只留元信息',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(peaks, { file: [tone] }, { output: 'file' });
    try {
      assert.equal(result.files.length, 1);
      assert.equal(result.primary, result.files[0]);
      assert.equal(path.extname(result.files[0]), '.json');
      assert.equal(path.dirname(result.files[0]), ctx.outputRoot);
      const data = result.data as PeaksData;
      assert.equal(data.peaks, undefined);
      const saved = JSON.parse(fs.readFileSync(result.files[0], 'utf8')) as PeaksData;
      assert.equal(saved.points, 1000);
      assert.equal((saved.peaks as number[][]).length, 1000);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('peaks：没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  const { error } = await runExpectingError(peaks, { file: [noAudio] });
  assert.match(error.message, /没有音轨/);
});

test('peaks：取消任务时立即停止，不留产物', { skip: ffmpegSkip }, async () => {
  const controller = new AbortController();
  const { error, outputs } = await runExpectingError(
    peaks,
    { file: [tone] },
    { output: 'file' },
    { signal: controller.signal, abortAfterStart: controller },
  );
  assert.match(error.message, /取消/);
  assert.deepEqual(outputs, []);
});

test('peaks：参数校验', () => {
  assert.deepEqual(paramErrors(peaks, { points: '50' }), ['points 必须是 100 到 20000 之间的整数']);
  assert.deepEqual(paramErrors(peaks, { points: '1000.5' }), [
    'points 必须是 100 到 20000 之间的整数',
  ]);
  assert.deepEqual(paramErrors(peaks, { channels: 'left' }), ['channels 只能是 mono / split']);
  assert.deepEqual(paramErrors(peaks, { output: 'csv' }), ['output 只能是 data / file']);
  assert.deepEqual(paramErrors(peaks, { channels: 'SPLIT', points: '20000' }), []);
});

test('peaks：computePeaks 按点统计最小 / 最大值', async () => {
  const tmp = fs.mkdtempSync(path.join(dir || process.cwd(), 'raw-'));
  try {
    const file = path.join(tmp, 'mono.raw');
    const samples = Buffer.alloc(20);
    for (let i = 0; i < 10; i++) samples.writeInt16LE(i * 100 - (i === 5 ? 2000 : 0), i * 2);
    fs.writeFileSync(file, samples);
    const stats = await computePeaks(file, 1, 3);
    assert.equal(stats.points, 3);
    assert.equal(stats.frames, 10);
    // 10 个采样分成 3 个点：[0-3] [4-6] [7-9]
    assert.deepEqual([...stats.min[0]], [0, -1500, 700]);
    assert.deepEqual([...stats.max[0]], [300, 600, 900]);
    assert.deepEqual(toPeakPairs(stats, 'mono', false), [
      [0, 0.0092],
      [-0.0458, 0.0183],
      [0.0214, 0.0275],
    ]);
    // 采样数少于请求的点数时每个采样一个点
    const fewer = await computePeaks(file, 1, 100);
    assert.equal(fewer.points, 10);

    const stereo = path.join(tmp, 'stereo.raw');
    const frames = Buffer.alloc(8);
    frames.writeInt16LE(1000, 0);
    frames.writeInt16LE(-32768, 2);
    frames.writeInt16LE(-500, 4);
    frames.writeInt16LE(16384, 6);
    fs.writeFileSync(stereo, frames);
    const two = await computePeaks(stereo, 2, 1);
    assert.deepEqual(toPeakPairs(two, 'split', false), [[[-0.0153, 0.0305]], [[-1, 0.5]]]);
    assert.deepEqual(toPeakPairs(two, 'mono', true), [[-1, 0.5]]);

    const empty = path.join(tmp, 'empty.raw');
    fs.writeFileSync(empty, Buffer.alloc(1));
    await assert.rejects(computePeaks(empty, 1, 100), /没有任何采样/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('peaks：pickSampleRate 控制中间文件大小并保证每个点有采样', () => {
  assert.equal(pickSampleRate(3600, 1000, 2), 8000);
  assert.equal(pickSampleRate(36000, 1000, 2), 2000);
  assert.ok(pickSampleRate(4 * 3600, 1000, 2) < 8000);
  assert.ok(pickSampleRate(4 * 3600, 1000, 2) >= 2000);
  assert.equal(pickSampleRate(1, 20000, 2), 48000);
  assert.equal(pickSampleRate(1, 1000, 2), 8000);
  assert.equal(pickSampleRate(0, 1000, 2), 8000);
});
