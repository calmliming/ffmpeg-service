import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, makeAudio, makeTempDir } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { buildScenes, scenes, type Scene } from '../../../../src/operations/analysis/scenes';
import { probeMedia } from '../../../../src/utils/media-probe';
import {
  averageColor,
  closeColor,
  makePipedSegments,
  makeSegments,
  runExpectingError,
} from './helpers';

let dir = '';
let cuts = '';
let audio = '';
let noDuration = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-scenes-');
  // 红 → 测试图案 → 蓝，每段 1 秒，带音轨（检测只看画面）
  cuts = makeSegments(dir, 'cuts.mp4', ['red', 'testsrc2', 'blue'], { audio: true });
  audio = makeAudio(dir, 'tone.wav', { duration: 1 });
  // 同样的三段画面，管道写成没有时长信息的 webm
  noDuration = makePipedSegments(dir, 'cuts-nodur.webm', ['red', 'testsrc2', 'blue']);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface ScenesData {
  duration: number;
  sceneCount: number;
  scenes: Scene[];
  truncated: boolean;
  thumbnailsTruncated?: boolean;
}

test('scenes：找到两个切换点，分成三个场景', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(scenes, { file: [cuts] }, { threshold: '0.3' });
  try {
    assert.deepEqual(result.files, []);
    const data = result.data as ScenesData;
    assert.equal(data.sceneCount, 3);
    assert.deepEqual(
      data.scenes.map((s) => [s.index, s.start, s.end]),
      [
        [0, 0, 1],
        [1, 1, 2],
        [2, 2, 3],
      ],
    );
    assert.equal(data.scenes[0].score, null);
    assert.ok(data.scenes.slice(1).every((s) => (s.score ?? 0) > 0.3));
    assert.equal(data.truncated, false);
    assert.equal(data.thumbnailsTruncated, undefined);
    // 检测分支被 select 丢帧，进度靠 split 出的完整画面汇报，最后到 1
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('scenes：thumbnails 为每个场景导出第一帧', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    scenes,
    { file: [cuts] },
    { thumbnails: 'true', thumbnailWidth: '160' },
  );
  try {
    const data = result.data as ScenesData;
    assert.equal(result.files.length, 3);
    assert.deepEqual(
      data.scenes.map((s) => s.thumbnail),
      ['scene_001.jpg', 'scene_002.jpg', 'scene_003.jpg'],
    );
    assert.deepEqual(
      result.files.map((f) => path.basename(f)),
      ['scene_001.jpg', 'scene_002.jpg', 'scene_003.jpg'],
    );
    // 所有缩略图在同一个产物子目录里
    assert.equal(new Set(result.files.map((f) => path.dirname(f))).size, 1);
    assert.equal(path.dirname(path.dirname(result.files[0])), ctx.outputRoot);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 160);
    assert.equal(info.video?.height, 120);
    // 切换点上的帧属于新场景：第一张红、第三张蓝
    assert.ok(closeColor(averageColor(result.files[0]), [255, 0, 0], 40));
    assert.ok(closeColor(averageColor(result.files[2]), [0, 0, 255], 40));
    assert.equal(data.thumbnailsTruncated, false);
    const fractions = ctx.progressCalls.map((c) => c.fraction);
    assert.ok(
      fractions.every((f, i) => i === 0 || f >= fractions[i - 1]),
      '进度应单调增长',
    );
    assert.equal(fractions.at(-1), 1);
  } finally {
    await ctx.cleanup();
  }
});

test('scenes：minInterval 过滤离开头太近的切换点', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(scenes, { file: [cuts] }, { minInterval: 1.5 });
  try {
    const data = result.data as ScenesData;
    assert.deepEqual(
      data.scenes.map((s) => [s.start, s.end]),
      [
        [0, 2],
        [2, 3],
      ],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('scenes：阈值很高时整段视频是一个场景', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(scenes, { file: [cuts] }, { threshold: 0.95 });
  try {
    const data = result.data as ScenesData;
    assert.equal(data.sceneCount, 1);
    assert.deepEqual(data.scenes[0], {
      index: 0,
      start: 0,
      end: 3,
      duration: 3,
      score: null,
    });
  } finally {
    await ctx.cleanup();
  }
});

test('scenes：没有时长信息的 webm，最后一个场景延续到实际结尾', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(scenes, { file: [noDuration] });
  try {
    const data = result.data as ScenesData;
    assert.equal(data.duration, 3);
    assert.deepEqual(
      data.scenes.map((s) => [s.index, s.start, s.end, s.duration]),
      [
        [0, 0, 1, 1],
        [1, 1, 2, 1],
        [2, 2, 3, 1],
      ],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('scenes：纯音频文件直接失败', { skip: ffmpegSkip }, async () => {
  const { error, outputs } = await runExpectingError(scenes, { file: [audio] });
  assert.match(error.message, /没有视频画面/);
  assert.deepEqual(outputs, []);
});

test('scenes：参数校验', () => {
  assert.deepEqual(paramErrors(scenes, { threshold: '0.01' }), [
    'threshold 必须是 0.05 到 0.95 之间的数字',
  ]);
  assert.deepEqual(paramErrors(scenes, { minInterval: '-1' }), [
    'minInterval 必须是 0 到 3600 之间的数字',
  ]);
  assert.deepEqual(paramErrors(scenes, { thumbnailWidth: '8' }), [
    'thumbnailWidth 必须是 16 到 1920 之间的整数',
  ]);
  assert.deepEqual(paramErrors(scenes, { thumbnails: 'yes', threshold: '0.5' }), []);
});

test('scenes：buildScenes 按时间排序并补上开头的场景', () => {
  const list = buildScenes(
    [
      { time: 4.5, score: 0.61234 },
      { time: 2, score: 0.5 },
      { time: 0, score: 0.9 },
    ],
    6,
  );
  assert.deepEqual(list, [
    { index: 0, start: 0, end: 2, duration: 2, score: null },
    { index: 1, start: 2, end: 4.5, duration: 2.5, score: 0.5 },
    { index: 2, start: 4.5, end: 6, duration: 1.5, score: 0.6123 },
  ]);
  assert.deepEqual(buildScenes([], 0), [{ index: 0, start: 0, end: 0, duration: 0, score: null }]);
});
