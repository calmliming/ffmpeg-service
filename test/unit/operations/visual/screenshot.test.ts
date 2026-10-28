import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { screenshot } from '../../../../src/operations/visual/screenshot';
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

const TS_RATE = 5;

let dir = '';
let video = '';
let rotated = '';
let anamorphic = '';
let audioOnly = '';
let ts = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-shot-');
  video = makeVideo(dir, 'v.mp4');
  audioOnly = makeAudio(dir, 'a.m4a');
  // 没有索引的 MPEG-TS，25 秒、每 12 秒一个关键帧；亮度随帧号递增，按像素能反查是哪一帧
  ts = makeRamp(path.join(dir, 'ramp.ts'), {
    rate: TS_RATE,
    duration: 25,
    perFrame: 1.6,
    gop: 60,
    format: 'mpegts',
  });
  // 手机竖拍：存储 320x240，带 90° 旋转标记，显示为 240x320
  rotated = path.join(dir, 'rotated.mp4');
  generate(['-display_rotation', '90', '-i', video, '-c', 'copy', rotated]);
  // 像素宽高比 4:3 的变形宽银幕，显示宽度约 427
  anamorphic = path.join(dir, 'anamorphic.mkv');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25:duration=1',
    '-vf',
    'setsar=4/3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    anamorphic,
  ]);
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('screenshot：按请求顺序每个时间点一张图', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    screenshot,
    { file: [video] },
    { timestamps: '1.5,00:00:00.5,50%', format: 'jpg', width: '160' },
  );
  try {
    assert.equal(result.files.length, 3);
    for (const file of result.files) {
      assert.deepEqual(await dimensions(file), { width: 160, height: 120 });
      assert.equal(await codecOf(file), 'mjpeg');
    }
    const data = result.data as { frames: { time: number; file: string }[] };
    assert.deepEqual(
      data.frames.map((f) => f.time),
      [1.5, 0.5, 1],
    );
    assert.deepEqual(
      data.frames.map((f) => f.file),
      result.files.map((f) => path.basename(f)),
    );
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'screenshot：每张图是输出目录顶层的独立文件，文件名全局唯一（与旧版一致）',
  { skip: ffmpegSkip },
  async () => {
    // 子目录里的固定文件名（screenshot-01.png）在 SAVE_OUTPUT_FILE=false 时下载后不会被删除，
    // 旧客户端用 /api/files/<output 的文件名> 拼出的链接也是 404
    const first = await runOperation(screenshot, { file: [video] }, { timestamps: '0.5,1' });
    const second = await runOperation(screenshot, { file: [video] }, { timestamps: '0.5' });
    try {
      const names = [...first.result.files, ...second.result.files].map((f) => path.basename(f));
      for (const name of names) assert.match(name, /^[0-9a-f-]{36}\.png$/);
      assert.equal(new Set(names).size, names.length);
      for (const file of first.result.files) assert.equal(path.dirname(file), first.ctx.outputRoot);
      assert.equal(path.dirname(second.result.files[0]), second.ctx.outputRoot);
      assert.deepEqual(fs.readdirSync(first.ctx.outputRoot).sort(), names.slice(0, 2).sort());
    } finally {
      await first.ctx.cleanup();
      await second.ctx.cleanup();
    }
  },
);

test(
  'screenshot：MPEG-TS 输入截到的是请求的那一帧，而不是之后的关键帧',
  { skip: ffmpegSkip },
  async () => {
    // 关键帧在 0、12、24 秒：7 秒在第一个 margin 内要从头解码；13 秒粗跳到 3 秒后从 12 秒的关键帧解码；
    // 23 秒粗跳到 13 秒会落到 24 秒的关键帧（越过目标），要退回从头解码
    const { result, ctx } = await runOperation(
      screenshot,
      { file: [ts] },
      { timestamps: '7,23,13', format: 'png' },
    );
    try {
      const table = frameTable(ts);
      const data = result.data as { frames: { time: number }[] };
      assert.deepEqual(
        data.frames.map((f) => f.time),
        [7, 23, 13],
      );
      result.files.forEach((file, i) => {
        const wanted = frameAtOrAfter(data.frames[i].time, TS_RATE);
        const got = matchFrame(file, table);
        assert.ok(Math.abs(got - wanted) <= 1, `第 ${i + 1} 张应为第 ${wanted} 帧，实际 ${got}`);
      });
    } finally {
      await ctx.cleanup();
    }
  },
);

test('screenshot：数组形式、时间点等于时长时取最后一帧、webp', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    screenshot,
    { file: [video] },
    { timestamps: [0, '2', '100%'], format: 'webp' },
  );
  try {
    assert.equal(result.files.length, 3);
    for (const file of result.files) {
      assert.equal(await codecOf(file), 'webp');
      assert.deepEqual(await dimensions(file), { width: 320, height: 240 });
    }
    const data = result.data as { frames: { time: number }[] };
    assert.ok(data.frames[1].time > 1.9 && data.frames[1].time < 2);
  } finally {
    await ctx.cleanup();
  }
});

test('screenshot：旋转视频按显示方向输出，变形宽银幕先拉正', { skip: ffmpegSkip }, async () => {
  const rot = await runOperation(screenshot, { file: [rotated] }, { timestamps: '1' });
  try {
    assert.deepEqual(await dimensions(rot.result.files[0]), { width: 240, height: 320 });
    assert.equal(await codecOf(rot.result.files[0]), 'png');
  } finally {
    await rot.ctx.cleanup();
  }
  const wide = await runOperation(screenshot, { file: [anamorphic] }, { timestamps: '0.5' });
  try {
    const { width, height } = await dimensions(wide.result.files[0]);
    assert.equal(height, 240);
    assert.ok(Math.abs(width - 427) <= 1, `宽度 ${width}`);
  } finally {
    await wide.ctx.cleanup();
  }
});

test('screenshot：时间点超出视频时长时报错', { skip: ffmpegSkip }, async () => {
  await runFails(
    screenshot,
    { file: [video] },
    { timestamps: '1,5' },
    /时间点 5 秒超出视频画面时长 2 秒/,
  );
});

test('screenshot：按 width 等比放大后超过尺寸上限时报错', { skip: ffmpegSkip }, async () => {
  // 竖屏 240x320 放大到 7680 宽，高度 10240
  await runFails(
    screenshot,
    { file: [rotated] },
    { timestamps: '1', width: '7680' },
    /按 width=7680 等比缩放后图片尺寸为 7680x10240 超过上限/,
  );
});

test('screenshot：纯音频输入给出明确错误', { skip: ffmpegSkip }, async () => {
  await runFails(screenshot, { file: [audioOnly] }, { timestamps: '1' }, /不包含视频画面/);
});

test('screenshot：参数校验', () => {
  assert.deepEqual(paramErrors(screenshot, {}), ['请提供 timestamps 参数（逗号分隔）']);
  assert.deepEqual(paramErrors(screenshot, { timestamps: ' , ' }), [
    '请提供 timestamps 参数（逗号分隔）',
  ]);
  assert.match(paramErrors(screenshot, { timestamps: '1,abc' })[0], /「abc」不是有效的时间/);
  assert.match(paramErrors(screenshot, { timestamps: '150%' })[0], /「150%」不是有效的时间/);
  const many = Array.from({ length: 51 }, (_, i) => String(i)).join(',');
  assert.deepEqual(paramErrors(screenshot, { timestamps: many }), ['timestamps 最多 50 个时间点']);
  assert.match(paramErrors(screenshot, { timestamps: '1', format: 'gif' })[0], /format 只能是/);
  assert.match(paramErrors(screenshot, { timestamps: '1', width: '8' })[0], /width 必须是/);
  // 旧版写法
  assert.deepEqual(paramErrors(screenshot, { timestamps: '00:00:02,00:00:05,00:00:08' }), []);
});
