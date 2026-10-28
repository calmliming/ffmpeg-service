import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';
import { config } from '../../../../src/config';
import {
  reframe,
  reframeCanvas,
  reframeLayout,
  blurBackgroundChain,
} from '../../../../src/operations/geometry/reframe';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { expectRunError, makeQuadVideo, near, pixelAt } from './helpers';

let dir = '';
let video = '';
let quad = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-geo-reframe-');
  video = makeVideo(dir, 'in.mp4');
  quad = makeQuadVideo(dir, 'quad.mp4');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('reframe: 横屏转 9:16，模糊背景，前景完整居中', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    reframe,
    { file: [quad] },
    { aspect: '9:16', shortSide: '180' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 180);
    assert.equal(info.video?.height, 320);
    assert.deepEqual(result.data, {
      width: 180,
      height: 320,
      foreground: { fgWidth: 180, fgHeight: 136, x: 0, y: 92 },
    });
    // 前景四个色块完整保留
    assert.ok(near(pixelAt(result.files[0], 0.5, 5, 100), 'red'));
    assert.ok(near(pixelAt(result.files[0], 0.5, 175, 220), 'white'));
    // 背景是模糊后的画面，不是纯黑
    const bg = pixelAt(result.files[0], 0.5, 90, 20);
    assert.ok(!near(bg, 'black', 30), `背景颜色 ${bg}`);
  } finally {
    await ctx.cleanup();
  }
});

test('reframe: 纯色背景，保留音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    reframe,
    { file: [video] },
    { aspect: '1:1', shortSide: 240, background: 'color', backgroundColor: 'yellow' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 240);
    assert.equal(info.video?.height, 240);
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 2) < 0.15, `时长 ${info.duration}`);
    // 320x240 缩到 240x180，上下各 30 像素黄色
    assert.ok(near(pixelAt(result.files[0], 0.5, 120, 5), 'yellow'));
    assert.ok(near(pixelAt(result.files[0], 0.5, 120, 235), 'yellow'));
  } finally {
    await ctx.cleanup();
  }
});

test('reframe: upscale=false 时前景不放大，size 指定分辨率', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    reframe,
    { file: [quad] },
    { size: '400x400', upscale: 'false', dim: 0.5 },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 400);
    assert.equal(info.video?.height, 400);
    assert.deepEqual((result.data as { foreground: unknown }).foreground, {
      fgWidth: 320,
      fgHeight: 240,
      x: 40,
      y: 80,
    });
    assert.ok(near(pixelAt(result.files[0], 0.5, 45, 85), 'red'));
  } finally {
    await ctx.cleanup();
  }
});

test('reframe: 比例相同时直接缩放，不生成背景', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    reframe,
    { file: [quad] },
    { aspect: '4:3', shortSide: 480 },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 640);
    assert.equal(info.video?.height, 480);
    assert.ok(near(pixelAt(result.files[0], 0.5, 2, 2), 'red'));
  } finally {
    await ctx.cleanup();
  }
});

test('reframe: 取消任务时立即杀掉 ffmpeg', { skip: ffmpegSkip }, async () => {
  const long = makeVideo(dir, 'long.mp4', { duration: 20 });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(new Error('任务已取消')), 500);
  await expectRunError(reframe, { file: [long] }, { aspect: '9:16' }, /任务已取消/, {
    signal: controller.signal,
  });
  assert.ok(Date.now() - started < 5000, '取消后应当很快结束');
});

test('reframe: 纯音频输入报错', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'a.mp3');
  await expectRunError(reframe, { file: [audio] }, { aspect: '9:16' }, /不包含视频画面/);
});

test('reframe: 参数校验', () => {
  assert.deepEqual(paramErrors(reframe, {}), ['请提供 aspect（如 9:16）或 size（如 1080x1920）']);
  assert.deepEqual(paramErrors(reframe, { aspect: '9:16', size: '1080x1920' }), [
    'aspect 和 size 不能同时使用',
  ]);
  assert.deepEqual(paramErrors(reframe, { size: '1080x1920', shortSide: 720 }), [
    'shortSide 只能和 aspect 一起使用',
  ]);
  assert.deepEqual(paramErrors(reframe, { aspect: '21:9', shortSide: 4320 }), [
    '输出尺寸 10080x4320 超过上限 7680x4320（竖屏 4320x7680）',
  ]);
  assert.deepEqual(paramErrors(reframe, { size: '8000x8000' }), [
    '输出尺寸 8000x8000 超过上限 7680x4320（竖屏 4320x7680）',
  ]);
  assert.match(paramErrors(reframe, { size: 'big' })[0], /size 必须是 宽x高 格式/);
  assert.deepEqual(paramErrors(reframe, { aspect: '9:16', blur: 80 }), [
    'blur 必须是 1 到 50 之间的整数',
  ]);
  assert.match(
    paramErrors(reframe, { aspect: '9:16', background: 'color', backgroundColor: 'nope' })[0],
    /backgroundColor 必须是颜色名/,
  );
});

test('reframe: 各比例的默认分辨率', () => {
  const schema = reframe.params;
  const canvas = (raw: Record<string, unknown>) =>
    reframeCanvas(
      schema.parse(raw) as z.output<typeof schema> & Parameters<typeof reframeCanvas>[0],
    );
  assert.deepEqual(canvas({ aspect: '16:9' }), { width: 1920, height: 1080 });
  assert.deepEqual(canvas({ aspect: '9:16' }), { width: 1080, height: 1920 });
  assert.deepEqual(canvas({ aspect: '1:1' }), { width: 1080, height: 1080 });
  assert.deepEqual(canvas({ aspect: '4:3' }), { width: 1440, height: 1080 });
  assert.deepEqual(canvas({ aspect: '3:4' }), { width: 1080, height: 1440 });
  assert.deepEqual(canvas({ aspect: '4:5' }), { width: 1080, height: 1350 });
  assert.deepEqual(canvas({ aspect: '21:9' }), { width: 2520, height: 1080 });
  assert.deepEqual(canvas({ aspect: '9:16', shortSide: 720 }), { width: 720, height: 1280 });
  assert.deepEqual(canvas({ size: '1281x721' }), { width: 1280, height: 720 });
});

test('reframe: 前景布局和模糊半径夹取', () => {
  assert.deepEqual(reframeLayout(1920, 1080, 1080, 1920, true), {
    fgWidth: 1080,
    fgHeight: 608,
    x: 0,
    y: 656,
  });
  assert.deepEqual(reframeLayout(640, 360, 1080, 1920, false), {
    fgWidth: 640,
    fgHeight: 360,
    x: 220,
    y: 780,
  });
  // 极小画布不加 boxblur（半径上限为 0），避免 FFmpeg 报半径越界
  assert.ok(!blurBackgroundChain(8, 8, 50, 0).some((f) => f.startsWith('boxblur')));
  const chain = blurBackgroundChain(1080, 1920, 50, 0.3);
  const radius = Number(/boxblur=(\d+)/.exec(chain.join(','))?.[1]);
  assert.ok(radius >= 1 && radius <= Math.floor(270 / 4), `半径 ${radius}`);
  assert.ok(chain.includes('lutyuv=y=(val-16)*0.7+16'));
});

test(
  'reframe: blur=50 在常见画布上半径不越界（FFmpeg 真跑模糊背景链）',
  { skip: ffmpegSkip },
  () => {
    // 小图短边能被 4 整除时，旧的上限 min/4 正好等于色度平面短边的一半，boxblur 报 Invalid argument
    const canvases: [number, number][] = [
      [720, 1280],
      [1280, 720],
      [720, 720],
      [400, 500],
      [1080, 1920],
      [1920, 1080],
      [640, 360],
      [144, 256],
      [16, 16],
    ];
    for (const [w, h] of canvases) {
      const chain = blurBackgroundChain(w, h, 50, 0);
      const res = spawnSync(
        config.ffmpegPath,
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `testsrc2=s=${w}x${h}:r=25:d=0.04`,
          '-vf',
          chain.join(','),
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(res.status, 0, `${w}x${h}: ${res.stderr}`);
    }
    // 720x1280 的小图 180x320：色度平面短边 90，半径最大 44；强度只在上限处夹住
    assert.ok(blurBackgroundChain(720, 1280, 50, 0).includes('boxblur=44:2'));
    assert.ok(blurBackgroundChain(720, 1280, 20, 0).includes('boxblur=18:2'));
  },
);

test('reframe: 9:16 + shortSide=720 + blur=50 能正常输出', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    reframe,
    { file: [quad] },
    { aspect: '9:16', shortSide: 720, blur: 50 },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 720);
    assert.equal(info.video?.height, 1280);
  } finally {
    await ctx.cleanup();
  }
});
