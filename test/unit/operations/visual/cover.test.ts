import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cover, parseSelectedTime } from '../../../../src/operations/visual/cover';
import { ffmpegSkip, generate, makeAudio, makeImage, makeTempDir } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  assertColor,
  codecOf,
  dimensions,
  frameAtOrAfter,
  frameTable,
  makeRamp,
  matchFrame,
  pixelAt,
  runFails,
} from './visual-helpers';

const TS_RATE = 5;

let dir = '';
let redBlue = '';
let long = '';
let audioOnly = '';
let ts = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-cover-');
  // 没有索引的 MPEG-TS，25 秒、每 12 秒一个关键帧；亮度随帧号递增，按像素能反查是哪一帧
  ts = makeRamp(path.join(dir, 'ramp.ts'), {
    rate: TS_RATE,
    duration: 25,
    perFrame: 1.6,
    gop: 60,
    format: 'mpegts',
  });
  // 1 秒红 + 2 秒蓝：整体颜色分布更接近蓝色，代表帧应当是蓝色的
  redBlue = path.join(dir, 'red-blue.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=320x240:rate=25:duration=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:size=320x240:rate=25:duration=2',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    redBlue,
  ]);
  // 400 秒的小画面，走只解码关键帧的分支
  long = path.join(dir, 'long.mkv');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x48:rate=2:duration=400',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '10',
    long,
  ]);
  audioOnly = makeAudio(dir, 'a.mp3');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('cover：挑出最有代表性的一帧', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(cover, { file: [redBlue] }, {});
  try {
    assert.equal(result.files.length, 1);
    assert.match(result.files[0], /\.jpg$/);
    assert.equal(await codecOf(result.files[0]), 'mjpeg');
    assert.deepEqual(await dimensions(result.files[0]), { width: 320, height: 240 });
    const data = result.data as { time: number };
    assert.ok(data.time >= 1 && data.time < 3, `选中时间 ${data.time}`);
    assertColor(pixelAt(result.files[0], 0, 160, 120), [0, 0, 255], 60);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.cleanup();
  }
});

test('cover：within 限定在开头一段，width 缩放，png', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    cover,
    { file: [redBlue] },
    { within: '1', width: '160', format: 'png' },
  );
  try {
    assert.deepEqual(await dimensions(result.files[0]), { width: 160, height: 120 });
    assert.equal(await codecOf(result.files[0]), 'png');
    const data = result.data as { time: number };
    assert.ok(data.time < 1, `选中时间 ${data.time}`);
    assertColor(pixelAt(result.files[0], 0, 80, 60), [255, 0, 0], 60);
  } finally {
    await ctx.cleanup();
  }
});

test('cover：长视频只解码关键帧', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(cover, { file: [long] }, { format: 'webp' });
  try {
    assert.equal(await codecOf(result.files[0]), 'webp');
    const data = result.data as { time: number };
    assert.ok(data.time >= 0 && data.time < 400);
    // 没有走「没选出帧、退回开始时间」的兜底
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'cover：MPEG-TS 输入在 startTime 之后的窗口里挑选，截到的就是选中的帧',
  { skip: ffmpegSkip },
  async () => {
    // 关键帧在 0、12、24 秒：直接跳到 13 秒会从 24 秒的关键帧才开始解码，13-17 秒的窗口一帧都分析不到
    const { result, ctx } = await runOperation(
      cover,
      { file: [ts] },
      { startTime: 13, within: 4, format: 'png' },
    );
    try {
      const data = result.data as { time: number };
      assert.ok(data.time >= 13 && data.time <= 17, `选中时间 ${data.time}`);
      // 没有走「没选出帧、退回开始时间」的兜底
      assert.deepEqual(ctx.logs, []);
      const wanted = frameAtOrAfter(data.time, TS_RATE);
      const got = matchFrame(result.files[0], frameTable(ts));
      assert.ok(Math.abs(got - wanted) <= 1, `应为第 ${wanted} 帧，实际 ${got}`);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('cover：单张图片当视频传入时直接输出这张图', { skip: ffmpegSkip }, async () => {
  const still = makeImage(dir, 'still.png', { size: '64x48', color: 'green' });
  const { result, ctx } = await runOperation(cover, { file: [still] }, { format: 'png' });
  try {
    assert.deepEqual(await dimensions(result.files[0]), { width: 64, height: 48 });
    assertColor(pixelAt(result.files[0], 0, 32, 24), [0, 128, 0], 40);
    assert.equal((result.data as { time: number }).time, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('cover：开始时间超出时长、纯音频输入时报错', { skip: ffmpegSkip }, async () => {
  await runFails(cover, { file: [redBlue] }, { startTime: '10' }, /开始时间 10 秒超出/);
  await runFails(cover, { file: [audioOnly] }, {}, /不包含视频画面/);
});

test('cover：解析 thumbnail 滤镜日志', () => {
  const log =
    '[Parsed_thumbnail_2 @ 0000] frame id #6 (pts_time=1.200000) selected from a set of 10 images';
  assert.equal(parseSelectedTime(log), 1.2);
  assert.equal(parseSelectedTime('nothing'), undefined);
});

test('cover：参数校验', () => {
  assert.deepEqual(paramErrors(cover, {}), []);
  assert.match(paramErrors(cover, { within: '0' })[0], /within 必须是 1 到 86400/);
  assert.match(paramErrors(cover, { format: 'bmp' })[0], /format 只能是 png \/ jpg \/ webp/);
  assert.match(paramErrors(cover, { quality: '0' })[0], /quality 必须是 1 到 100/);
});
