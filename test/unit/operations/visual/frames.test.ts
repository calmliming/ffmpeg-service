import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { frames } from '../../../../src/operations/visual/frames';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import {
  codecOf,
  dimensions,
  frameAtOrAfter,
  frameTable,
  makeRamp,
  matchFrame,
  runFails,
} from './visual-helpers';

interface FramesData {
  count: number;
  interval: number;
  frames: { time: number; file: string }[];
}

const RAMP_RATE = 25;
const TS_RATE = 5;

let dir = '';
let video = '';
let long = '';
let big = '';
let hours = '';
let audioOnly = '';
let ramp = '';
let ts = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-frames-');
  video = makeVideo(dir, 'v.mp4');
  // 亮度随帧号递增，按像素反查是哪一帧
  ramp = makeRamp(path.join(dir, 'ramp.mp4'), { rate: RAMP_RATE, duration: 2, perFrame: 4 });
  ts = makeRamp(path.join(dir, 'ramp.ts'), {
    rate: TS_RATE,
    duration: 25,
    perFrame: 1.6,
    gop: 60,
    format: 'mpegts',
  });
  long = makeVideo(dir, 'long.mp4', { size: '160x120', duration: 12, audio: false });
  big = makeVideo(dir, 'big.mp4', { size: '1280x720', duration: 20, audio: false });
  hours = path.join(dir, 'hours.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:size=32x32:rate=1:duration=200',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    hours,
  ]);
  audioOnly = makeAudio(dir, 'a.flac');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('frames：按 fps 抽帧', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(frames, { file: [video] }, { fps: '2' });
  try {
    const data = result.data as FramesData;
    assert.equal(data.count, 4);
    assert.equal(result.files.length, 4);
    assert.deepEqual(
      data.frames.map((f) => f.time),
      [0, 0.5, 1, 1.5],
    );
    assert.deepEqual(
      data.frames.map((f) => f.file),
      ['frame-0001.jpg', 'frame-0002.jpg', 'frame-0003.jpg', 'frame-0004.jpg'],
    );
    assert.equal(new Set(result.files.map((f) => path.dirname(f))).size, 1);
    assert.equal(await codecOf(result.files[0]), 'mjpeg');
    assert.deepEqual(await dimensions(result.files[0]), { width: 320, height: 240 });
  } finally {
    await ctx.cleanup();
  }
});

test('frames：时间范围 + interval + 宽度 + webp', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    frames,
    { file: [video] },
    { interval: '0.5', startTime: '0.5', endTime: '00:00:01.5', width: '160', format: 'webp' },
  );
  try {
    const data = result.data as FramesData;
    assert.deepEqual(
      data.frames.map((f) => f.time),
      [0.5, 1],
    );
    assert.equal(await codecOf(result.files[0]), 'webp');
    assert.deepEqual(await dimensions(result.files[1]), { width: 160, height: 120 });
  } finally {
    await ctx.cleanup();
  }
});

test('frames：count 模式取每段中点', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    frames,
    { file: [video] },
    { count: 4, format: 'png' },
  );
  try {
    const data = result.data as FramesData;
    assert.deepEqual(
      data.frames.map((f) => f.time),
      [0.25, 0.75, 1.25, 1.75],
    );
    assert.equal(await codecOf(result.files[0]), 'png');
  } finally {
    await ctx.cleanup();
  }
});

test('frames：count 超过范围内的实际帧数时按实际帧数输出', { skip: ffmpegSkip }, async () => {
  // 25 fps，0-0.2 秒只有 5 帧
  const { result, ctx } = await runOperation(
    frames,
    { file: [video] },
    { count: 20, endTime: '0.2' },
  );
  try {
    const data = result.data as FramesData;
    assert.equal(data.count, 5);
    assert.equal(result.files.length, 5);
    assert.ok(ctx.logs.some((l) => l.includes('count 从 20 降为 5')));
  } finally {
    await ctx.cleanup();
  }
});

test('frames：间隔大时逐帧跳转，结尾不越界', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(frames, { file: [long] }, { interval: 5 });
  try {
    const data = result.data as FramesData;
    assert.deepEqual(
      data.frames.map((f) => f.time),
      [0, 5, 10],
    );
    assert.equal(result.files.length, 3);
  } finally {
    await ctx.cleanup();
  }
});

/** 每张图都是 data.frames[].time 处或之后的第一帧 */
function assertFramesMatch(
  result: { files: string[]; data?: unknown },
  table: number[],
  rate: number,
  tolerance: number,
): void {
  const data = result.data as FramesData;
  result.files.forEach((file, i) => {
    const wanted = frameAtOrAfter(data.frames[i].time, rate);
    const got = matchFrame(file, table);
    assert.ok(
      Math.abs(got - wanted) <= tolerance,
      `第 ${i + 1} 张（${data.frames[i].time}s）应为第 ${wanted} 帧，实际 ${got}`,
    );
  });
}

test(
  'frames：整段解码时每张都是时间点处或之后的第一帧，不晚半个间隔',
  { skip: ffmpegSkip },
  async () => {
    const table = frameTable(ramp);
    // fps 模式：0、0.5、1、1.5 秒
    const byFps = await runOperation(frames, { file: [ramp] }, { fps: 2, format: 'png' });
    try {
      assert.deepEqual(
        (byFps.result.data as FramesData).frames.map((f) => f.time),
        [0, 0.5, 1, 1.5],
      );
      assertFramesMatch(byFps.result, table, RAMP_RATE, 0);
    } finally {
      await byFps.ctx.cleanup();
    }
    // count 模式取每段中点，起点不在帧边界上
    const byCount = await runOperation(
      frames,
      { file: [ramp] },
      { count: 4, startTime: '0.3', endTime: '1.9', format: 'png' },
    );
    try {
      assert.equal(byCount.result.files.length, 4);
      assertFramesMatch(byCount.result, table, RAMP_RATE, 0);
    } finally {
      await byCount.ctx.cleanup();
    }
    // 间隔比帧距还小：同一帧重复，后面的帧不会错位
    const dense = await runOperation(
      frames,
      { file: [ramp] },
      { interval: 0.02, endTime: '0.2', format: 'png' },
    );
    try {
      assert.equal(dense.result.files.length, 10);
      assertFramesMatch(dense.result, table, RAMP_RATE, 0);
    } finally {
      await dense.ctx.cleanup();
    }
  },
);

test('frames：MPEG-TS 输入从请求的时间点开始抽帧', { skip: ffmpegSkip }, async () => {
  const table = frameTable(ts);
  // 关键帧在 0、12、24 秒。13 秒起：粗跳到 3 秒，从 12 秒的关键帧解码
  const near = await runOperation(
    frames,
    { file: [ts] },
    { interval: 2, startTime: 13, endTime: 21, format: 'png' },
  );
  try {
    assert.deepEqual(
      (near.result.data as FramesData).frames.map((f) => f.time),
      [13, 15, 17, 19],
    );
    assertFramesMatch(near.result, table, TS_RATE, 1);
  } finally {
    await near.ctx.cleanup();
  }
  // 23 秒起：粗跳到 13 秒会落到 24 秒的关键帧（越过起点），要退回从头解码
  const far = await runOperation(
    frames,
    { file: [ts] },
    { interval: 0.5, startTime: 23, format: 'png' },
  );
  try {
    assert.deepEqual(
      (far.result.data as FramesData).frames.map((f) => f.time),
      [23, 23.5, 24, 24.5],
    );
    assertFramesMatch(far.result, table, TS_RATE, 1);
  } finally {
    await far.ctx.cleanup();
  }
  // 间隔 5 秒逐帧跳转
  const seek = await runOperation(
    frames,
    { file: [ts] },
    { interval: 5, startTime: 3, format: 'png' },
  );
  try {
    assert.deepEqual(
      (seek.result.data as FramesData).frames.map((f) => f.time),
      [3, 8, 13, 18, 23],
    );
    assertFramesMatch(seek.result, table, TS_RATE, 1);
  } finally {
    await seek.ctx.cleanup();
  }
});

test('frames：超过 500 帧上限时报错', { skip: ffmpegSkip }, async () => {
  await runFails(frames, { file: [hours] }, { fps: 3 }, /约 600 帧，超过上限 500 帧/);
});

test('frames：开始时间超出时长时报错', { skip: ffmpegSkip }, async () => {
  await runFails(frames, { file: [video] }, { startTime: 5 }, /开始时间 5 秒超出视频画面时长 2 秒/);
});

test('frames：纯音频输入给出明确错误', { skip: ffmpegSkip }, async () => {
  await runFails(frames, { file: [audioOnly] }, {}, /不包含视频画面/);
});

test('frames：取消任务会终止 ffmpeg', { skip: ffmpegSkip }, async () => {
  const controller = new AbortController();
  const ctx = createTestContext({ file: [big] }, { signal: controller.signal });
  try {
    const running = frames.run(ctx, frames.params.parse({ fps: 20, format: 'png' }));
    setTimeout(() => controller.abort(new Error('任务已取消')), 300);
    await assert.rejects(running, /任务已取消/);
  } finally {
    await ctx.cleanup();
  }
});

test('frames：参数校验', () => {
  assert.deepEqual(paramErrors(frames, {}), []);
  assert.deepEqual(paramErrors(frames, { fps: 1, count: 5 }), [
    'fps、interval、count 只能指定其中一个',
  ]);
  assert.deepEqual(paramErrors(frames, { startTime: 3, endTime: 2 }), [
    '结束时间 endTime 必须大于开始时间 startTime',
  ]);
  assert.match(paramErrors(frames, { count: 501 })[0], /count 必须是 1 到 500/);
  assert.match(paramErrors(frames, { fps: 121 })[0], /fps 必须是/);
  assert.match(paramErrors(frames, { startTime: 'abc' })[0], /startTime 必须是秒数或 HH:MM:SS/);
});
