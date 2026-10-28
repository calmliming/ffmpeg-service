import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sprite, vttTime } from '../../../../src/operations/visual/sprite';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  codecOf,
  dimensions,
  frameAtOrAfter,
  frameTable,
  makeRamp,
  matchFrame,
  runFails,
} from './visual-helpers';

const RAMP_RATE = 25;

interface SpriteData {
  interval: number;
  columns: number;
  rows: number;
  thumbWidth: number;
  thumbHeight: number;
  count: number;
  sheets: string[];
  vtt: string;
}

let dir = '';
let video = '';
let long = '';
let rotated = '';
let hours = '';
let audioOnly = '';
let ramp = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-sprite-');
  // 亮度随帧号递增，按像素反查是哪一帧
  ramp = makeRamp(path.join(dir, 'ramp.mp4'), { rate: RAMP_RATE, duration: 2, perFrame: 4 });
  video = makeVideo(dir, 'v.mp4', { duration: 3 });
  long = makeVideo(dir, 'long.mp4', { size: '160x120', duration: 12, audio: false });
  rotated = path.join(dir, 'rotated.mp4');
  generate(['-display_rotation', '90', '-i', video, '-c', 'copy', rotated]);
  // 1 fps 的小画面，只为得到一个长时长
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
  audioOnly = makeAudio(dir, 'a.mp3');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

function cues(vtt: string): { start: string; end: string; ref: string }[] {
  return vtt
    .trim()
    .split(/\n\n/)
    .slice(1)
    .map((block) => {
      const [times, ref] = block.split('\n');
      const [start, end] = times.split(' --> ');
      return { start, end, ref };
    });
}

test('sprite：单张雪碧图 + WebVTT', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    sprite,
    { file: [video] },
    { interval: '0.5', columns: '4', thumbWidth: '80' },
  );
  try {
    const data = result.data as SpriteData;
    assert.deepEqual(data, {
      interval: 0.5,
      columns: 4,
      rows: 10,
      thumbWidth: 80,
      thumbHeight: 60,
      count: 6,
      sheets: ['sprite-1.jpg'],
      vtt: 'thumbnails.vtt',
    });
    assert.equal(result.primary, result.files[0]);
    assert.equal(path.basename(result.files[0]), 'thumbnails.vtt');
    assert.equal(result.files.length, 2);
    const sheet = path.join(path.dirname(result.files[0]), 'sprite-1.jpg');
    assert.equal(result.files[1], sheet);
    // 6 张 4 列 → 2 行
    assert.deepEqual(await dimensions(sheet), { width: 320, height: 120 });
    assert.equal(await codecOf(sheet), 'mjpeg');

    const vtt = fs.readFileSync(result.files[0], 'utf8');
    assert.ok(vtt.startsWith('WEBVTT\n\n'));
    const list = cues(vtt);
    assert.equal(list.length, 6);
    assert.deepEqual(list[0], {
      start: '00:00:00.000',
      end: '00:00:00.500',
      ref: 'sprite-1.jpg#xywh=0,0,80,60',
    });
    assert.deepEqual(list[5], {
      start: '00:00:02.500',
      end: '00:00:03.000',
      ref: 'sprite-1.jpg#xywh=80,60,80,60',
    });
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('sprite：超过行数时拆成多张图', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    sprite,
    { file: [video] },
    { count: '10', columns: '4', rows: '1', thumbWidth: '40', format: 'png' },
  );
  try {
    const data = result.data as SpriteData;
    assert.equal(data.count, 10);
    assert.equal(data.interval, 0.3);
    assert.deepEqual(data.sheets, ['sprite-1.png', 'sprite-2.png', 'sprite-3.png']);
    assert.equal(result.files.length, 4);
    const base = path.dirname(result.files[0]);
    for (const name of data.sheets) {
      assert.deepEqual(await dimensions(path.join(base, name)), { width: 160, height: 30 });
    }
    const list = cues(fs.readFileSync(result.files[0], 'utf8'));
    assert.equal(list[4].ref, 'sprite-2.png#xywh=0,0,40,30');
    assert.equal(list[9].ref, 'sprite-3.png#xywh=40,0,40,30');
    assert.equal(list[9].end, '00:00:03.000');
  } finally {
    await ctx.cleanup();
  }
});

test('sprite：自动间隔、间隔大时逐张跳转、旋转视频按显示比例', { skip: ffmpegSkip }, async () => {
  const auto = await runOperation(sprite, { file: [video] }, {});
  try {
    const data = auto.result.data as SpriteData;
    // 3 秒视频：时长/100 不足 1 秒，按 1 秒
    assert.equal(data.interval, 1);
    assert.equal(data.count, 3);
    assert.equal(data.columns, 3);
    assert.equal(data.thumbHeight, 120);
  } finally {
    await auto.ctx.cleanup();
  }

  const seek = await runOperation(sprite, { file: [long] }, { interval: 5, format: 'webp' });
  try {
    const data = seek.result.data as SpriteData;
    assert.equal(data.count, 3);
    const sheet = seek.result.files[1];
    assert.equal(await codecOf(sheet), 'webp');
    assert.deepEqual(await dimensions(sheet), { width: 480, height: 120 });
  } finally {
    await seek.ctx.cleanup();
  }

  const rot = await runOperation(sprite, { file: [rotated] }, { thumbWidth: 120 });
  try {
    const data = rot.result.data as SpriteData;
    assert.equal(data.thumbHeight, 160);
  } finally {
    await rot.ctx.cleanup();
  }
});

test('sprite：每个缩略图是 VTT 时间段开头处的画面', { skip: ffmpegSkip }, async () => {
  // 间隔 0.5 秒走整段解码：fps 滤镜默认四舍五入会取到每段开头之后约半个间隔的帧
  const { result, ctx } = await runOperation(
    sprite,
    { file: [ramp] },
    { interval: '0.5', columns: '4', thumbWidth: '64', format: 'png' },
  );
  try {
    const table = frameTable(ramp);
    const sheet = result.files[1];
    const list = cues(fs.readFileSync(result.files[0], 'utf8'));
    assert.equal(list.length, 4);
    list.forEach((cue, i) => {
      const [h, m, s] = cue.start.split(':').map(Number);
      const start = h * 3600 + m * 60 + s;
      const [x, y] = cue.ref.split('#xywh=')[1].split(',').map(Number);
      const got = matchFrame(sheet, table, x + 8, y + 8);
      assert.equal(got, frameAtOrAfter(start, RAMP_RATE), `第 ${i + 1} 个缩略图（${cue.start}）`);
    });
  } finally {
    await ctx.cleanup();
  }
});

test('sprite：指定的间隔会超过 1000 张时报错', { skip: ffmpegSkip }, async () => {
  await runFails(sprite, { file: [hours] }, { interval: '0.1' }, /2000 张缩略图，超过上限 1000 张/);
});

test('sprite：纯音频输入给出明确错误', { skip: ffmpegSkip }, async () => {
  await runFails(sprite, { file: [audioOnly] }, {}, /不包含视频画面/);
});

test('sprite：参数校验', () => {
  assert.deepEqual(paramErrors(sprite, {}), []);
  assert.deepEqual(paramErrors(sprite, { interval: 5, count: 10 }), [
    'interval 和 count 只能指定一个',
  ]);
  assert.deepEqual(paramErrors(sprite, { columns: 20, thumbWidth: 640 }), [
    '每张雪碧图宽度 columns × thumbWidth 不能超过 7680 像素',
  ]);
  assert.match(paramErrors(sprite, { thumbWidth: 30 })[0], /thumbWidth 必须是 40 到 640/);
  assert.match(paramErrors(sprite, { columns: 21 })[0], /columns 必须是 1 到 20/);
  assert.match(paramErrors(sprite, { count: 1001 })[0], /count 必须是 1 到 1000/);
  assert.match(paramErrors(sprite, { interval: 0 })[0], /interval 必须是/);
});

test('sprite：WebVTT 时间格式', () => {
  assert.equal(vttTime(0), '00:00:00.000');
  assert.equal(vttTime(3723.4567), '01:02:03.457');
});
