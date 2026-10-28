import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gif, gifLoopValue } from '../../../../src/operations/basic/gif';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  TS_H264,
  assertInside,
  assertNear,
  countFrames,
  expectRunError,
  extOf,
  facts,
  frameLuma,
  makeRamp,
} from './helpers';

let dir = '';
let video = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-basic-gif-');
  video = makeVideo(dir, 'in.mp4');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

/** GIF 的 NETSCAPE2.0 循环块：返回「额外重复次数」，没有循环块（只播一次）返回 undefined */
function gifLoopCount(file: string): number | undefined {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf('NETSCAPE2.0');
  if (at < 0) return undefined;
  // 应用扩展块：NETSCAPE2.0 后面是 03 01 <次数低字节> <次数高字节> 00
  assert.equal(buf[at + 11], 3);
  assert.equal(buf[at + 12], 1);
  return buf.readUInt16LE(at + 13);
}

interface WebpInfo {
  animated: boolean;
  width: number;
  height: number;
  loop?: number;
  frames: number;
  /** 顶层的 VP8 / VP8L 图像块：libwebp_anim 只有一帧时写成静态 WebP，没有 ANMF */
  stills: number;
}

/** 解析 WebP 的 RIFF 块（ffprobe 8.1 解不了动态 WebP） */
function webpInfo(file: string): WebpInfo {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const info: WebpInfo = { animated: false, width: 0, height: 0, frames: 0, stills: 0 };
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const type = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const data = pos + 8;
    if (type === 'VP8X') {
      info.animated = (buf[data] & 0x02) !== 0;
      info.width = buf.readUIntLE(data + 4, 3) + 1;
      info.height = buf.readUIntLE(data + 7, 3) + 1;
    } else if (type === 'ANIM') {
      info.loop = buf.readUInt16LE(data + 4);
    } else if (type === 'ANMF') {
      info.frames++;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      info.stills++;
    }
    pos = data + size + (size % 2);
  }
  return info;
}

/** APNG 的 acTL 块：帧数和播放次数 */
function apngControl(file: string): { frames: number; plays: number } | undefined {
  const buf = fs.readFileSync(file);
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'acTL') {
      return { frames: buf.readUInt32BE(pos + 8), plays: buf.readUInt32BE(pos + 12) };
    }
    pos += 12 + size;
  }
  return undefined;
}

test('gif: 默认 320 宽、10 fps、调色板、无限循环', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(gif, { file: [video] });
  try {
    const [out] = result.files;
    assertInside(ctx.outputRoot, out);
    assert.equal(extOf(out), 'gif');
    const f = await facts(out);
    assert.equal(f.video?.codec, 'gif');
    assert.equal(f.video?.width, 320);
    assert.equal(f.video?.height, 240);
    assert.equal(f.audio, undefined);
    assertNear(f.duration, 2, 0.15);
    assert.equal(gifLoopCount(out), 0, '0 = 无限循环');
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
    // 两遍：调色板阶段结束时进度停在 0.4
    assert.ok(ctx.progressCalls.some((c) => c.fraction === 0.4));
  } finally {
    await ctx.cleanup();
  }
});

test('gif: 旧版参数 startTime / duration / width / fps', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    gif,
    { file: [video] },
    { startTime: '00:00:00.5', duration: '1', width: '160', fps: '20' },
  );
  try {
    const f = await facts(result.files[0]);
    assert.equal(f.video?.width, 160);
    assert.equal(f.video?.height, 120);
    assertNear(f.duration, 1, 0.1);
  } finally {
    await ctx.cleanup();
  }
});

test('gif: loop 是总播放次数', { skip: ffmpegSkip }, async () => {
  const expected: [number, number | undefined][] = [
    [1, undefined],
    [3, 2],
  ];
  for (const [loop, count] of expected) {
    const { result, ctx } = await runOperation(
      gif,
      { file: [video] },
      { loop, duration: 0.5, width: 64, palette: false },
    );
    try {
      assert.equal(gifLoopCount(result.files[0]), count, `loop=${loop}`);
    } finally {
      await ctx.cleanup();
    }
  }
  assert.equal(gifLoopValue(0), 0);
  assert.equal(gifLoopValue(1), -1);
  assert.equal(gifLoopValue(5), 4);
});

test('gif: 调色板选项（颜色数、抖动）', { skip: ffmpegSkip }, async () => {
  const full = await runOperation(gif, { file: [video] }, { duration: 1 });
  const small = await runOperation(
    gif,
    { file: [video] },
    { duration: 1, maxColors: '16', dither: 'none' },
  );
  try {
    const a = fs.statSync(full.result.files[0]).size;
    const b = fs.statSync(small.result.files[0]).size;
    assert.ok(b < a, `16 色不抖动应当更小：${b} vs ${a}`);
  } finally {
    await full.ctx.cleanup();
    await small.ctx.cleanup();
  }
});

test('gif: 动态 WebP', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    gif,
    { file: [video] },
    { format: 'webp', width: 160, duration: 1, loop: 1, quality: 60 },
  );
  try {
    const [out] = result.files;
    assert.equal(extOf(out), 'webp');
    const info = webpInfo(out);
    assert.ok(info.animated);
    assert.equal(info.width, 160);
    assert.equal(info.height, 120);
    assert.equal(info.loop, 1);
    assert.ok(info.frames >= 9 && info.frames <= 11, `帧数 ${info.frames}`);
  } finally {
    await ctx.cleanup();
  }
});

test('gif: APNG 输出 .png，plays 等于 loop', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    gif,
    { file: [video] },
    { format: 'APNG', width: 96, duration: 0.5, loop: 2 },
  );
  try {
    const [out] = result.files;
    assert.equal(extOf(out), 'png');
    const f = await facts(out);
    assert.equal(f.video?.codec, 'apng');
    assert.equal(f.video?.width, 96);
    assert.equal(f.video?.height, 72);
    assert.deepEqual(apngControl(out), { frames: 5, plays: 2 });
  } finally {
    await ctx.cleanup();
  }
});

test('gif: 竖拍（旋转元数据）按显示方向计算高度', { skip: ffmpegSkip }, async () => {
  const rotated = path.join(dir, 'rotated.mp4');
  generate(['-display_rotation', '90', '-i', video, '-c', 'copy', rotated]);
  const { result, ctx } = await runOperation(
    gif,
    { file: [rotated] },
    { width: 120, duration: 0.5 },
  );
  try {
    const f = await facts(result.files[0]);
    assert.equal(f.video?.width, 120);
    assert.equal(f.video?.height, 160);
  } finally {
    await ctx.cleanup();
  }
});

test('gif: 不填 duration 时最多转 60 秒', { skip: ffmpegSkip }, async () => {
  const long = makeVideo(dir, 'long.mp4', { size: '64x48', rate: 5, duration: 62, audio: false });
  const { result, ctx } = await runOperation(
    gif,
    { file: [long] },
    { width: 16, fps: 1, palette: false },
  );
  try {
    assertNear((await facts(result.files[0])).duration, 60, 1.01);
  } finally {
    await ctx.cleanup();
  }
});

test('gif: MPEG-TS 输入的第一帧就是 startTime 处的画面', { skip: ffmpegSkip }, async () => {
  // 关键帧每 2 秒一个；直接输入端跳转时 5.3 秒起的动图从 6 秒的关键帧开始
  const ts = makeRamp(dir, 'ramp.ts', TS_H264);
  for (const palette of [true, false]) {
    const { result, ctx } = await runOperation(
      gif,
      { file: [ts] },
      { startTime: 5.3, duration: 1, width: 32, palette },
    );
    try {
      const [out] = result.files;
      assertNear(frameLuma(out), frameLuma(ts, 5.3), 4, `palette=${palette} 第一帧亮度`);
      const n = countFrames(out);
      assert.ok(Math.abs(n - 10) <= 1, `palette=${palette}：${n} 帧，预期 10`);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('gif: 起点贴近结尾或源只有一帧时输出单帧动图', { skip: ffmpegSkip }, async () => {
  // 2 秒 25 fps 的视频最后一帧在 1.96 秒：从 1.98 秒开始跳转会丢掉它，以前 gif 报 palette.png 打不开、webp 报内存不足
  const still = path.join(dir, 'still.gif');
  generate(['-f', 'lavfi', '-i', 'testsrc2=size=64x48', '-frames:v', '1', still]);
  const cases: [string, Record<string, unknown>][] = [
    [video, { startTime: 1.98 }],
    [video, { startTime: 1.98, format: 'webp' }],
    [video, { startTime: 1.98, format: 'apng' }],
    [video, { startTime: 1.98, palette: false }],
    [still, {}],
    [still, { format: 'webp' }],
  ];
  for (const [input, raw] of cases) {
    const label = `${path.basename(input)} ${JSON.stringify(raw)}`;
    const { result, ctx } = await runOperation(gif, { file: [input] }, { width: 32, ...raw });
    try {
      const [out] = result.files;
      // 只有一帧时 libwebp_anim / apng 编码器写成静态 WebP / 普通 PNG，同样是合法的单帧图
      const webp = raw.format === 'webp' ? webpInfo(out) : undefined;
      const frames = webp
        ? webp.frames + webp.stills
        : raw.format === 'apng'
          ? (apngControl(out)?.frames ?? countFrames(out))
          : countFrames(out);
      assert.equal(frames, 1, label);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('gif: 片段里解不出画面时给出明确的中文错误', { skip: ffmpegSkip }, async () => {
  // 去掉所有 IDR 帧：有视频流但一帧也解不出来，调色板生成不出来
  const ts = makeRamp(dir, 'ramp-broken-src.ts', TS_H264);
  const broken = path.join(dir, 'no-idr.ts');
  generate(['-i', ts, '-map', '0', '-c', 'copy', '-bsf:v', 'filter_units=remove_types=5', broken]);
  await expectRunError(
    gif,
    { file: [broken] },
    { startTime: 1, duration: 1 },
    /所选片段（1 秒起 1 秒）里没有可用的画面/,
  );
});

test('gif: 没有画面、起点超出时长时给出中文错误', { skip: ffmpegSkip }, async () => {
  const mp3 = makeAudio(dir, 'tone.mp3');
  await expectRunError(gif, { file: [mp3] }, {}, /输入文件没有视频画面/);
  const tall = makeVideo(dir, 'tall.mp4', { size: '16x400', duration: 0.2, audio: false });
  await expectRunError(
    gif,
    { file: [tall] },
    { width: 1280 },
    /动图高度 32000 超过上限 2560，请减小 width/,
  );
  await expectRunError(
    gif,
    { file: [video] },
    { startTime: 3 },
    /startTime（3 秒）超出了视频时长（2 秒）/,
  );
});

test('gif: 参数校验', () => {
  const one = (raw: Record<string, unknown>) => paramErrors(gif, raw).join(' | ');
  assert.match(one({ duration: 61 }), /duration 不能超过 60 秒/);
  assert.match(one({ duration: '00:01:30' }), /duration 不能超过 60 秒/);
  assert.match(one({ duration: 0 }), /duration 必须大于 0/);
  assert.match(one({ width: 2000 }), /width 必须是 16 到 1280 之间的整数/);
  assert.match(one({ width: '8' }), /width 必须是 16 到 1280 之间的整数/);
  assert.match(one({ width: '320.5' }), /width 必须是 16 到 1280 之间的整数/);
  assert.match(one({ fps: 0 }), /fps 必须是 1 到 60 之间的数字/);
  assert.match(one({ fps: 55 }), /gif 的帧率最高 50/);
  assert.match(one({ format: 'mp4' }), /format 只能是 gif \/ webp \/ apng/);
  assert.match(one({ loop: -1 }), /loop 必须是 0 到 65535 之间的整数/);
  assert.match(one({ palette: 'sometimes' }), /palette 必须是布尔值/);
  assert.match(one({ dither: 'random' }), /dither 只能是/);
  assert.match(
    one({ format: 'webp', dither: 'bayer' }),
    /dither 和 maxColors 只在 format=gif 且 palette=true 时有效/,
  );
  assert.match(one({ palette: false, maxColors: 32 }), /dither 和 maxColors 只在/);
  assert.match(one({ quality: 80 }), /quality 只在 format=webp 时有效/);
  assert.match(one({ startTime: 'later' }), /startTime 必须是秒数或 HH:MM:SS/);
  assert.deepEqual(paramErrors(gif, { format: 'webp', fps: 55, quality: '90' }), []);
  assert.deepEqual(paramErrors(gif, { duration: '60', width: '1280' }), []);
});
