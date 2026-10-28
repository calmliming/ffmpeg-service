import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ffmpegSkip, makeAudio, makeTempDir } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { black, parseBlacks } from '../../../../src/operations/analysis/black';
import type { Interval } from '../../../../src/operations/analysis/shared';
import { makePipedSegments, makeSegments, runExpectingError } from './helpers';

let dir = '';
let video = '';
let gray = '';
let audio = '';
let noDuration = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-black-');
  // 黑 → 测试图案 → 黑，每段 1 秒，带音轨
  video = makeSegments(dir, 'black.mp4', ['black', 'testsrc2', 'black'], { audio: true });
  // 深灰（亮度约 0.12）默认不算黑，调高 pixelThreshold 才算
  gray = makeSegments(dir, 'gray.mp4', ['0x202020', 'testsrc2']);
  audio = makeAudio(dir, 'tone.wav', { duration: 1 });
  // 同样的黑 → 测试图案 → 黑，管道写成没有时长信息的 webm
  noDuration = makePipedSegments(dir, 'black-nodur.webm', ['black', 'testsrc2', 'black']);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface BlackData {
  duration: number;
  count: number;
  totalBlack: number;
  intervals: Interval[];
  truncated: boolean;
}

test('black：找到开头和结尾的黑场，结尾对齐到视频末尾', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(black, { file: [video] }, { minDuration: '0.5' });
  try {
    assert.deepEqual(result.files, []);
    const data = result.data as BlackData;
    assert.equal(data.count, 2);
    assert.deepEqual(data.intervals, [
      { start: 0, end: 1, duration: 1 },
      { start: 2, end: 3, duration: 1 },
    ]);
    assert.equal(data.totalBlack, 2);
    assert.equal(data.truncated, false);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('black：minDuration 大于黑场时长时没有结果', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(black, { file: [video] }, { minDuration: 1.5 });
  try {
    const data = result.data as BlackData;
    assert.equal(data.count, 0);
    assert.deepEqual(data.intervals, []);
    assert.equal(data.totalBlack, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('black：pixelThreshold 决定深灰算不算黑', { skip: ffmpegSkip }, async () => {
  const strict = await runOperation(black, { file: [gray] });
  try {
    assert.equal((strict.result.data as BlackData).count, 0);
  } finally {
    await strict.ctx.cleanup();
  }
  const loose = await runOperation(black, { file: [gray] }, { pixelThreshold: '0.2' });
  try {
    const data = loose.result.data as BlackData;
    assert.deepEqual(data.intervals, [{ start: 0, end: 1, duration: 1 }]);
  } finally {
    await loose.ctx.cleanup();
  }
});

test(
  'black：没有时长信息的 webm 按实际解码长度返回 duration，结尾黑场对齐到末尾',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(black, { file: [noDuration] });
    try {
      const data = result.data as BlackData;
      assert.equal(data.duration, 3);
      assert.deepEqual(data.intervals, [
        { start: 0, end: 1, duration: 1 },
        { start: 2, end: 3, duration: 1 },
      ]);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('black：纯音频文件直接失败', { skip: ffmpegSkip }, async () => {
  const { error } = await runExpectingError(black, { file: [audio] });
  assert.match(error.message, /没有视频画面/);
});

test('black：参数校验', () => {
  assert.deepEqual(paramErrors(black, { pixelThreshold: '2' }), [
    'pixelThreshold 必须是 0 到 1 之间的数字',
  ]);
  assert.deepEqual(paramErrors(black, { pictureThreshold: 'abc' }), [
    'pictureThreshold 必须是 0 到 1 之间的数字',
  ]);
  assert.deepEqual(paramErrors(black, { minDuration: '0' }), [
    'minDuration 必须是 0.01 到 3600 之间的数字',
  ]);
});

test('black：解析日志，结尾差一帧时补齐到总时长', () => {
  const stderr = [
    '    title           : [Parsed_blackdetect_0 @ 0x1] black_start:0 black_end:5',
    '[Parsed_blackdetect_0 @ 0x2] black_start:0 black_end:1 black_duration:1',
    '[Parsed_blackdetect_0 @ 0x2] black_start:2 black_end:2.96 black_duration:0.96',
  ].join('\n');
  assert.deepEqual(parseBlacks(stderr, 3, 25), [
    { start: 0, end: 1, duration: 1 },
    { start: 2, end: 3, duration: 1 },
  ]);
  // 离结尾超过 1.5 帧的不补
  assert.deepEqual(parseBlacks(stderr, 3.5, 25)[1], { start: 2, end: 2.96, duration: 0.96 });
});
