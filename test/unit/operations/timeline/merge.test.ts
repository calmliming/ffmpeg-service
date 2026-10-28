import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mergeOperation,
  snapToFrame,
  transitionOffsets,
  xfadeOffsetArg,
} from '../../../../src/operations/timeline/merge';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  flashOnsets,
  frameLuma,
  makeHalfVideo,
  makeRampVideo,
  makeSyncClip,
  meanVolumeDb,
  near,
  regionLuma,
  toneOnsets,
} from './helpers';

interface MergeData {
  duration: number;
  normalized: boolean;
  reasons: string[];
  transitions: string[];
  offsets?: number[];
}

let dir = '';
let a = '';
let b = '';
let silent = '';
let small = '';

/** 纯色片段，转场测试用亮度区分前后两段 */
function colorClip(name: string, color: string, duration = 2, audio = true): string {
  const file = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=25:d=${duration}`];
  if (audio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`);
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-ac', '2');
  args.push(file);
  generate(args);
  return file;
}

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-merge-');
  a = makeVideo(dir, 'a.mp4', { duration: 2, freq: 440 });
  b = makeVideo(dir, 'b.mp4', { duration: 2, freq: 660 });
  silent = makeVideo(dir, 'silent.mp4', { duration: 2, audio: false });
  small = makeVideo(dir, 'small.mp4', { duration: 1.5, size: '240x240', rate: 30 });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('transitionOffsets', () => {
  assert.deepEqual(transitionOffsets([2, 2, 2], 0.5), [1.5, 3]);
  assert.deepEqual(transitionOffsets([3, 1, 4], 1), [2, 2]);
});

test('snapToFrame / xfadeOffsetArg：转场从最近的一帧开始，不因取整晚一帧', () => {
  // ffprobe 给出的 6 位小数时长对齐回整帧
  assert.equal(snapToFrame(2.066667, 30), 62 / 30);
  assert.equal(snapToFrame(1.21, 25), 1.2);
  // 134/30 = 4.4667：按毫秒写成 4.467 会落在第 134 帧之后，往前让半帧就稳定从这一帧开始
  assert.equal(xfadeOffsetArg(134 / 30, 30), '4.45');
  assert.equal(xfadeOffsetArg(0, 30), '0');
});

test('参数校验', () => {
  const two = { files: 2 };
  assert.deepEqual(paramErrors(mergeOperation, {}, two), []);
  assert.deepEqual(paramErrors(mergeOperation, { transition: 'NONE' }, two), []);
  assert.deepEqual(paramErrors(mergeOperation, { transition: 'fade,WipeLeft' }, two), []);
  assert.match(paramErrors(mergeOperation, { transition: 'explode' }, two)[0], /"explode" 不支持/);
  assert.deepEqual(paramErrors(mergeOperation, { transition: 'none,fade' }, two), [
    'transition 为 none 时不能再指定其他转场',
  ]);
  assert.deepEqual(paramErrors(mergeOperation, { transitionDuration: 6 }, two), [
    'transitionDuration 必须是 0.1 到 5 之间的数字',
  ]);
  assert.deepEqual(paramErrors(mergeOperation, { fit: 'stretch' }, two), ['fit 只能是 pad / crop']);
  const tooBig = ['size 不能超过 7680x4320（竖屏 4320x7680）'];
  assert.deepEqual(paramErrors(mergeOperation, { size: '8000x8000' }, two), tooBig);
  assert.deepEqual(paramErrors(mergeOperation, { size: '8000x2000' }, two), tooBig);
  assert.deepEqual(paramErrors(mergeOperation, { size: '4320x7680' }, two), []);
  assert.deepEqual(paramErrors(mergeOperation, {}, { files: 1 }), ['请至少提供 2 个视频']);
  assert.deepEqual(paramErrors(mergeOperation, {}, { files: 21 }), [
    '最多拼接 20 个视频，当前 21 个',
  ]);
});

test('参数完全一致的视频直接流复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(mergeOperation, { files: [a, b, a] });
  try {
    const data = result.data as MergeData;
    assert.equal(data.normalized, false);
    assert.deepEqual(data.reasons, []);
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 6, 0.1), `时长 ${info.duration}`);
    assert.equal(info.video?.width, 320);
    assert.ok(info.audio);
  } finally {
    await ctx.cleanup();
  }
});

test('分辨率 / 帧率不同、缺音轨时统一转码后拼接', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(mergeOperation, { files: [a, small, silent] });
  try {
    const data = result.data as MergeData;
    assert.equal(data.normalized, true);
    assert.ok(data.reasons.length > 0);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.equal(info.video?.frameRate, '25/1');
    assert.ok(near(info.duration, 5.5, 0.15), `时长 ${info.duration}`);
    assert.ok(info.audio);
    // 第 3 段没有声音，补的是静音
    assert.ok(meanVolumeDb(result.files[0], 4, 1) < -60);
    assert.ok(meanVolumeDb(result.files[0], 2.2, 1) > -40);
    const phases = ctx.progressCalls.map((c) => c.extra?.phase);
    assert.ok(phases.includes('normalizing') && phases.includes('merging'));
    const normalizing = ctx.progressCalls.find((c) => c.extra?.currentVideoIndex === 3);
    assert.equal(normalizing?.extra?.totalVideos, 3);
  } finally {
    await ctx.cleanup();
  }
});

test('size / fps / fit=crop 强制统一参数', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    mergeOperation,
    { files: [a, b] },
    { size: '200x200', fps: '15', fit: 'crop' },
  );
  try {
    assert.equal((result.data as MergeData).normalized, true);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 200);
    assert.equal(info.video?.height, 200);
    assert.equal(info.video?.frameRate, '15/1');
  } finally {
    await ctx.cleanup();
  }
});

test(
  'fade 转场：每个衔接处重叠 transitionDuration 秒，声音交叉淡化',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      mergeOperation,
      { files: [a, silent, small] },
      { transition: 'fade', transitionDuration: '0.5' },
    );
    try {
      const data = result.data as MergeData;
      assert.deepEqual(data.transitions, ['fade', 'fade']);
      assert.deepEqual(data.offsets, [1.5, 3]);
      assert.ok(near(data.duration, 4.5, 0.05), `data.duration ${data.duration}`);
      const info = await probeMedia(result.files[0]);
      assert.ok(near(info.duration, 4.5, 0.1), `时长 ${info.duration}`);
      assert.equal(info.video?.width, 320);
      assert.ok(info.audio);
      // 第 2 段（无声）完整播放的区间 2-3 秒应静音，第 3 段 3.5 秒之后有声音
      assert.ok(meanVolumeDb(result.files[0], 2.1, 0.8) < -60);
      assert.ok(meanVolumeDb(result.files[0], 3.6, 0.8) > -40);
      const fractions = ctx.progressCalls.map((c) => c.fraction);
      assert.deepEqual(
        fractions,
        [...fractions].sort((x, y) => x - y),
        '进度应单调递增',
      );
      assert.equal(fractions[fractions.length - 1], 1);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('多种转场按顺序用于每个衔接处；画面在转场中途是两段的混合', { skip: ffmpegSkip }, async () => {
  const black = colorClip('black.mp4', 'black');
  const white = colorClip('white.mp4', 'white');
  const { result, ctx } = await runOperation(
    mergeOperation,
    { files: [black, white, black] },
    { transition: 'dissolve,fadewhite', transitionDuration: 1 },
  );
  try {
    assert.deepEqual((result.data as MergeData).transitions, ['dissolve', 'fadewhite']);
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.ok(near(info.duration, 4, 0.1), `时长 ${info.duration}`);
    assert.ok(frameLuma(out, 0.3) < 20, '开头是黑场');
    const mid = frameLuma(out, 1.5);
    assert.ok(mid > 60 && mid < 200, `转场中途应是混合亮度: ${mid}`);
    assert.ok(frameLuma(out, 2.2) > 230, '第 2 段是白场');
    assert.ok(frameLuma(out, 3.8) < 20, '结尾是黑场');
  } finally {
    await ctx.cleanup();
  }
});

test('转场：帧率取整不会让声音逐段提前，每段画面和声音保持同步', { skip: ffmpegSkip }, async () => {
  // 第 1 段 30 fps 决定目标帧率；20 fps 的 1.05 秒统一成 30 fps 后是 32 帧（1.0667 秒），比声音长 1/60 秒
  const first = makeSyncClip(dir, 'sync30.mp4', { duration: 1.5, rate: 30 });
  const odd = makeSyncClip(dir, 'sync20.mp4', { duration: 1.05, rate: 20 });
  const { result, ctx } = await runOperation(
    mergeOperation,
    { files: [first, odd, odd, odd, odd, odd, odd] },
    { transition: 'fade', transitionDuration: 0.3 },
  );
  try {
    const out = result.files[0];
    const data = result.data as MergeData;
    const clip = 32 / 30;
    const expectedOffsets = [1.2];
    for (let k = 1; k < 6; k++) expectedOffsets.push(expectedOffsets[k - 1] + clip - 0.3);
    assert.deepEqual(
      data.offsets,
      expectedOffsets.map((o) => Number(o.toFixed(3))),
    );
    const total = 1.5 + 6 * clip - 6 * 0.3;
    assert.ok(near(data.duration, total, 0.002), `data.duration ${data.duration}`);
    const info = await probeMedia(out);
    assert.ok(near(info.video!.duration, total, 0.02), `画面时长 ${info.video!.duration}`);
    assert.ok(
      near(info.audio!.duration, info.video!.duration, 0.03),
      `声音 ${info.audio!.duration} 秒，画面 ${info.video!.duration} 秒`,
    );
    // 每段的白场都在该段起点后 0.5 秒，转场起点要落在算好的帧上，不能因为 offset 四舍五入晚一帧
    const flashes = flashOnsets(out, 30);
    const expectedFlashes = [0.5, ...expectedOffsets.map((o) => o + 0.5)];
    assert.equal(flashes.length, 7, `白场 ${flashes.join(', ')}`);
    flashes.forEach((t, i) => {
      assert.ok(near(t, expectedFlashes[i], 0.005), `第 ${i + 1} 段白场在 ${t} 秒`);
    });
    const beeps = toneOnsets(out);
    assert.equal(beeps.length, 7, `提示音 ${beeps.join(', ')}`);
    beeps.forEach((t, i) => {
      assert.ok(near(t, flashes[i], 0.02), `第 ${i + 1} 段白场 ${flashes[i]} 秒，提示音 ${t} 秒`);
    });
  } finally {
    await ctx.cleanup();
  }
});

test('带旋转信息的竖拍视频按转正后的尺寸统一', { skip: ffmpegSkip }, async () => {
  // 存储 320x180、旋转 90 度，播放时是 180x320：上半黑、下半白
  const rot = makeHalfVideo(dir, 'rot.mp4', { rotation: 90 });
  const half = makeHalfVideo(dir, 'half.mp4');
  const top = { x: 0, y: 0, w: 1, h: 0.25 };
  const bottom = { x: 0, y: 0.75, w: 1, h: 0.25 };

  const faded = await runOperation(
    mergeOperation,
    { files: [rot, rot] },
    { transition: 'fade', transitionDuration: 0.3 },
  );
  try {
    const out = faded.result.files[0];
    const info = await probeMedia(out);
    assert.deepEqual([info.video?.width, info.video?.height, info.video?.rotation], [180, 320, 0]);
    assert.ok(regionLuma(out, 0.3, top) < 30, '上方应是黑色');
    assert.ok(regionLuma(out, 0.3, bottom) > 220, '下方应是白色，画面不是缩在中间的小图');
  } finally {
    await faded.ctx.cleanup();
  }

  // 不加转场：方向不同不能流复制，横屏片段在竖屏画面里上下补黑边，而不是跟着第 1 段转歪
  const mixed = await runOperation(mergeOperation, { files: [rot, half] });
  try {
    const data = mixed.result.data as MergeData;
    assert.equal(data.normalized, true);
    assert.match(data.reasons.join(';'), /旋转 90°/);
    const out = mixed.result.files[0];
    const info = await probeMedia(out);
    assert.deepEqual([info.video?.width, info.video?.height, info.video?.rotation], [180, 320, 0]);
    assert.ok(regionLuma(out, 0.5, bottom) > 220, '第 1 段下方应是白色');
    assert.ok(regionLuma(out, 1.5, bottom) < 30, '第 2 段下方应是黑边');
    assert.ok(regionLuma(out, 1.5, { x: 0.05, y: 0.45, w: 0.4, h: 0.1 }) > 220, '第 2 段中间偏左');
    assert.ok(regionLuma(out, 1.5, { x: 0.55, y: 0.45, w: 0.4, h: 0.1 }) < 30, '第 2 段中间偏右');
  } finally {
    await mixed.ctx.cleanup();
  }

  // 方向一致时仍流复制，旋转信息原样保留
  const same = await runOperation(mergeOperation, { files: [rot, rot] });
  try {
    assert.equal((same.result.data as MergeData).normalized, false);
    const info = await probeMedia(same.result.files[0]);
    assert.equal(info.video?.rotation, 90);
  } finally {
    await same.ctx.cleanup();
  }
});

test('非方形像素（SAR 不是 1:1）的视频按显示比例缩放', { skip: ffmpegSkip }, async () => {
  // 存储 240x240、SAR 4:3，显示成 320x240，和第 1 段（320x240）比例相同，统一后应铺满画面
  const anamorphic = path.join(dir, 'anamorphic.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=240x240:r=25:d=1,setsar=4/3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    anamorphic,
  ]);
  const { result, ctx } = await runOperation(mergeOperation, { files: [a, anamorphic] });
  try {
    assert.equal((result.data as MergeData).normalized, true);
    const out = result.files[0];
    const left = regionLuma(out, 2.5, { x: 0, y: 0, w: 0.1, h: 1 });
    assert.ok(left > 220, `第 2 段左侧应是画面而不是黑边: ${left}`);
  } finally {
    await ctx.cleanup();
  }
});

test('全部没有音轨时输出也没有音轨', { skip: ffmpegSkip }, async () => {
  const silent2 = makeRampVideo(dir, 'silent2.mp4', { duration: 2, size: '320x240' });
  const { result, ctx } = await runOperation(
    mergeOperation,
    { files: [silent, silent2] },
    { transition: 'slideleft', transitionDuration: 0.4 },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio, undefined);
    assert.ok(near(info.duration, 3.6, 0.1), `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
});

test('转场时长不小于某个视频时清楚报错', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(
      mergeOperation,
      { files: [a, small] },
      { transition: 'fade', transitionDuration: 1.5 },
    ),
    /第 2 个视频只有 1.5 秒，转场时长 1.5 秒必须小于每个视频的时长/,
  );
});

test('音频文件不能参与拼接', { skip: ffmpegSkip }, async () => {
  const wav = makeAudio(dir, 'a.wav', { duration: 1 });
  await assert.rejects(
    runOperation(mergeOperation, { files: [a, wav] }),
    /第 2 个文件不包含视频画面/,
  );
});

test('VP9 + Opus 的 webm 即使参数一致也要转码才能放进 MP4', { skip: ffmpegSkip }, async () => {
  const webm = path.join(dir, 'clip.webm');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=25:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-c:a',
    'libopus',
    webm,
  ]);
  const { result, ctx } = await runOperation(mergeOperation, { files: [webm, webm] });
  try {
    const data = result.data as MergeData;
    assert.equal(data.normalized, true);
    assert.match(data.reasons.join(';'), /不能直接封装进 MP4/);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.codec, 'h264');
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(near(info.duration, 2, 0.15), `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
});
