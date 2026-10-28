import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { thumbnail } from '../../../../src/operations/visual/thumbnail';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
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

const RAMP_RATE = 25;
const TS_RATE = 5;

let dir = '';
let wide = '';
let long = '';
let audioOnly = '';
let ramp = '';
let ts = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-thumb-');
  wide = makeVideo(dir, 'wide.mp4', { size: '640x360' });
  long = makeVideo(dir, 'long.mp4', { size: '160x120', duration: 24, audio: false });
  audioOnly = makeAudio(dir, 'a.wav');
  // 亮度随帧号递增，按像素反查是哪一帧：2 秒 50 帧，每帧差 4
  ramp = makeRamp(path.join(dir, 'ramp.mp4'), { rate: RAMP_RATE, duration: 2, perFrame: 4 });
  ts = makeRamp(path.join(dir, 'ramp.ts'), {
    rate: TS_RATE,
    duration: 25,
    perFrame: 1.6,
    gop: 60,
    format: 'mpegts',
  });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('thumbnail：默认 6 张 320x240，均匀分布在 i/(count+1) 处', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(thumbnail, { file: [wide] }, {});
  try {
    assert.equal(result.files.length, 6);
    for (const file of result.files) {
      assert.deepEqual(await dimensions(file), { width: 320, height: 240 });
      assert.equal(await codecOf(file), 'png');
    }
    const data = result.data as { frames: { time: number; file: string }[] };
    data.frames.forEach((frame, i) => {
      assert.ok(Math.abs(frame.time - (2 * (i + 1)) / 7) < 0.01, `第 ${i + 1} 张 ${frame.time}`);
      assert.equal(frame.file, path.basename(result.files[i]));
    });
  } finally {
    await ctx.cleanup();
  }
});

test(
  'thumbnail：每张图是输出目录顶层的独立文件，文件名全局唯一（与旧版一致）',
  { skip: ffmpegSkip },
  async () => {
    // 子目录里的固定文件名（thumbnail-0001.png）在 SAVE_OUTPUT_FILE=false 时下载后不会被删除，
    // 旧客户端用 /api/files/<output 的文件名> 拼出的链接也是 404
    const first = await runOperation(thumbnail, { file: [wide] }, { count: 2, format: 'jpg' });
    const second = await runOperation(thumbnail, { file: [wide] }, { count: 1, format: 'jpg' });
    try {
      const names = [...first.result.files, ...second.result.files].map((f) => path.basename(f));
      for (const name of names) assert.match(name, /^[0-9a-f-]{36}\.jpg$/);
      assert.equal(new Set(names).size, names.length);
      for (const file of first.result.files) assert.equal(path.dirname(file), first.ctx.outputRoot);
      assert.deepEqual(fs.readdirSync(first.ctx.outputRoot).sort(), names.slice(0, 2).sort());
      const data = first.result.data as { frames: { time: number; file: string }[] };
      assert.deepEqual(
        data.frames.map((f) => f.file),
        names.slice(0, 2),
      );
      // 时间先后与文件顺序一致
      assert.ok(data.frames[0].time < data.frames[1].time);
      // 中间文件不留在 workDir
      assert.deepEqual(
        fs.readdirSync(first.ctx.workDir).filter((f) => f.startsWith('thumbnail-')),
        [],
      );
    } finally {
      await first.ctx.cleanup();
      await second.ctx.cleanup();
    }
  },
);

test(
  'thumbnail：取到的是 i/(count+1) 处或之后的第一帧，而不是晚半个间隔',
  { skip: ffmpegSkip },
  async () => {
    // 间隔不到 5 秒走整段解码：fps 滤镜默认四舍五入会取到每个时间点之后约半个间隔的帧
    const { result, ctx } = await runOperation(
      thumbnail,
      { file: [ramp] },
      { size: '64x48', format: 'png' },
    );
    try {
      const table = frameTable(ramp);
      const data = result.data as { frames: { time: number }[] };
      assert.equal(result.files.length, 6);
      result.files.forEach((file, i) => {
        const wanted = frameAtOrAfter(data.frames[i].time, RAMP_RATE);
        assert.equal(matchFrame(file, table), wanted, `第 ${i + 1} 张（${data.frames[i].time}s）`);
      });
    } finally {
      await ctx.cleanup();
    }
  },
);

test('thumbnail：MPEG-TS 输入取到的是请求时间点的帧', { skip: ffmpegSkip }, async () => {
  // 25 秒、每 12 秒一个关键帧；count=5 间隔约 4.17 秒，走整段解码，起点 4.17 秒不在关键帧上
  const { result, ctx } = await runOperation(
    thumbnail,
    { file: [ts] },
    { count: 5, size: '64x48', format: 'png' },
  );
  try {
    const table = frameTable(ts);
    const data = result.data as { frames: { time: number }[] };
    result.files.forEach((file, i) => {
      const wanted = frameAtOrAfter(data.frames[i].time, TS_RATE);
      const got = matchFrame(file, table);
      assert.ok(Math.abs(got - wanted) <= 1, `第 ${i + 1} 张应为第 ${wanted} 帧，实际 ${got}`);
    });
  } finally {
    await ctx.cleanup();
  }
});

test('thumbnail：只给一边时等比缩放', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    thumbnail,
    { file: [wide] },
    { count: '2', size: '160x?', format: 'jpg' },
  );
  try {
    assert.equal(result.files.length, 2);
    assert.deepEqual(await dimensions(result.files[0]), { width: 160, height: 90 });
    assert.equal(await codecOf(result.files[0]), 'mjpeg');
  } finally {
    await ctx.cleanup();
  }
});

test('thumbnail：旧版的百分比写法，只给一边时另一边超限报错', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    thumbnail,
    { file: [wide] },
    { count: '1', size: '25%' },
  );
  try {
    assert.deepEqual(await dimensions(result.files[0]), { width: 160, height: 90 });
  } finally {
    await ctx.cleanup();
  }
  // 16:9 画面高度给 7680，宽度会是 13653
  await runFails(thumbnail, { file: [wide] }, { size: '?x7680' }, /缩略图尺寸 13653x7680 超过上限/);
});

test('thumbnail：contain 补边、cover 裁切', { skip: ffmpegSkip }, async () => {
  const contain = await runOperation(
    thumbnail,
    { file: [wide] },
    { count: 1, size: '160x160', fit: 'contain', padColor: 'red', format: 'jpg' },
  );
  try {
    assert.deepEqual(await dimensions(contain.result.files[0]), { width: 160, height: 160 });
    // 16:9 画面缩到 160x90，上下各补 35 像素红边
    assertColor(pixelAt(contain.result.files[0], 0, 80, 10), [255, 0, 0], 60);
  } finally {
    await contain.ctx.cleanup();
  }

  const transparent = await runOperation(
    thumbnail,
    { file: [wide] },
    { count: 1, size: '160x160', fit: 'contain', padColor: 'black@0' },
  );
  try {
    const info = await probeMedia(transparent.result.files[0]);
    assert.equal(info.video?.pixFmt, 'rgba');
  } finally {
    await transparent.ctx.cleanup();
  }

  // 不透明的补边颜色不需要透明通道
  const opaque = await runOperation(
    thumbnail,
    { file: [wide] },
    { count: 1, size: '160x160', fit: 'contain' },
  );
  try {
    const info = await probeMedia(opaque.result.files[0]);
    assert.equal(info.video?.pixFmt, 'rgb24');
  } finally {
    await opaque.ctx.cleanup();
  }

  const cover = await runOperation(
    thumbnail,
    { file: [wide] },
    { count: 1, size: '160x160', fit: 'cover', format: 'webp' },
  );
  try {
    assert.deepEqual(await dimensions(cover.result.files[0]), { width: 160, height: 160 });
    assert.equal(await codecOf(cover.result.files[0]), 'webp');
  } finally {
    await cover.ctx.cleanup();
  }
});

test('thumbnail：长视频逐张跳转截取', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(thumbnail, { file: [long] }, { count: 3 });
  try {
    assert.equal(result.files.length, 3);
    const data = result.data as { frames: { time: number }[] };
    assert.deepEqual(
      data.frames.map((f) => f.time),
      [6, 12, 18],
    );
    // 每张一条命令，进度逐段增长
    const fractions = ctx.progressCalls.map((c) => c.fraction);
    assert.deepEqual(
      fractions,
      [...fractions].sort((a, b) => a - b),
    );
    assert.equal(fractions.at(-1), 1);
  } finally {
    await ctx.cleanup();
  }
});

test('thumbnail：纯音频输入给出明确错误', { skip: ffmpegSkip }, async () => {
  await runFails(thumbnail, { file: [audioOnly] }, {}, /不包含视频画面/);
});

test('thumbnail：参数校验', () => {
  assert.deepEqual(paramErrors(thumbnail, {}), []);
  assert.match(paramErrors(thumbnail, { count: '51' })[0], /count 必须是 1 到 50 之间的整数/);
  assert.match(paramErrors(thumbnail, { count: '2.5' })[0], /count 必须是/);
  assert.match(paramErrors(thumbnail, { size: 'big' })[0], /size 必须是 宽x高/);
  assert.match(paramErrors(thumbnail, { size: '?x?' })[0], /size 必须是 宽x高/);
  assert.match(paramErrors(thumbnail, { size: '7680x7680' })[0], /总像素不超过/);
  assert.match(paramErrors(thumbnail, { size: '150%' })[0], /size 必须是 宽x高/);
  assert.match(paramErrors(thumbnail, { size: '0%' })[0], /size 必须是 宽x高/);
  assert.deepEqual(paramErrors(thumbnail, { size: '50%' }), []);
  assert.match(
    paramErrors(thumbnail, { fit: 'fill' })[0],
    /fit 只能是 stretch \/ contain \/ cover/,
  );
  assert.match(paramErrors(thumbnail, { padColor: 'red;x' })[0], /padColor 必须是颜色名/);
  // 旧版写法
  assert.deepEqual(paramErrors(thumbnail, { count: '8', size: '640x360' }), []);
});
