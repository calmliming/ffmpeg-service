import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanWatermarkText, watermark } from '../../../../src/operations/visual/watermark';
import { probeMedia, probeRaw } from '../../../../src/utils/media-probe';
import {
  ffmpegSkip,
  generate,
  makeAudio,
  makeImage,
  makeTempDir,
  makeVideo,
} from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import { assertColor, pixelAt, runFails } from './visual-helpers';

let dir = '';
let video = '';
let silent = '';
let black = '';
let red = '';
let oddPcm = '';
let long = '';
let audioOnly = '';
let anamorphicOdd = '';
let anamorphicBlack = '';
let hugeLogo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-wm-');
  video = makeVideo(dir, 'v.mp4');
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
  red = makeImage(dir, 'red.png', { size: '40x40', color: 'red' });
  audioOnly = makeAudio(dir, 'a.mp3');
  // 纯黑底视频，方便按像素颜色断言水印位置；扩展名故意给错，模拟 URL 下载的文件
  black = path.join(dir, 'black.bin');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:size=320x240:rate=25:duration=3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'mp4',
    black,
  ]);
  // 奇数尺寸 + PCM 音轨的 mov：输出要补成偶数尺寸，音轨不能直接复制进 mp4
  oddPcm = path.join(dir, 'odd.mov');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=321x241:rate=25:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv444p',
    '-c:a',
    'pcm_s16le',
    '-shortest',
    oddPcm,
  ]);
  long = makeVideo(dir, 'long.mp4', { duration: 30, size: '640x360' });
  // 像素宽高比 2:3、存储宽度 321（奇数），显示宽度 214 是偶数
  anamorphicOdd = path.join(dir, 'anamorphic-odd.mkv');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=321x240:rate=25:duration=1',
    '-vf',
    'setsar=2/3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv444p',
    anamorphicOdd,
  ]);
  // 超过 7680 像素宽的水印图片
  hugeLogo = makeImage(dir, 'huge.png', { size: '8000x16', color: 'blue' });
  // 纯黑底的变形宽银幕：存储 320x240、SAR 2:1，显示为 640x240
  anamorphicBlack = path.join(dir, 'anamorphic-black.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:size=320x240:rate=25:duration=2',
    '-vf',
    'setsar=2/1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    anamorphicBlack,
  ]);
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('watermark：中文文字水印，保留音轨并流复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    watermark,
    { file: [video] },
    {
      text: '水印测试 Hello',
      position: 'bottom-center',
      fontSize: '28',
      fontColor: '#FFFF00',
      boxColor: 'black@0.5',
      borderWidth: '1',
    },
  );
  try {
    assert.equal(result.files.length, 1);
    assert.match(result.files[0], /\.mp4$/);
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.equal(info.video?.codec, 'h264');
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 2) < 0.2, `时长 ${info.duration}`);
    // 文字通过 workDir 里的文件传给 drawtext
    assert.equal(fs.readFileSync(path.join(ctx.workDir, 'wm.txt'), 'utf8'), '水印测试 Hello');
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('watermark：图片水印的位置、缩放、出现时间段', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    watermark,
    { file: [black], image: [red] },
    { position: 'top-left', margin: '10', imageScale: '0.25', startTime: '1', endTime: '2' },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.audio, undefined);
    // imageScale=0.25 → 80x80 的红块，左上角 (10,10) 起
    assertColor(pixelAt(out, 1.5, 50, 50), [255, 0, 0], 60);
    assertColor(pixelAt(out, 1.5, 85, 85), [255, 0, 0], 60);
    assertColor(pixelAt(out, 1.5, 100, 100), [0, 0, 0]);
    assertColor(pixelAt(out, 1.5, 300, 220), [0, 0, 0]);
    // 时间段外不显示
    assertColor(pixelAt(out, 0.5, 50, 50), [0, 0, 0]);
    assertColor(pixelAt(out, 2.5, 50, 50), [0, 0, 0]);
  } finally {
    await ctx.cleanup();
  }
});

test('watermark：图片透明度与右下角位置', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    watermark,
    { file: [black], image: [red] },
    { imageWidth: '40', opacity: '0.5', margin: '0' },
  );
  try {
    // 默认 bottom-right，40x40 贴着右下角；半透明红叠在黑底上约为 (128,0,0)
    const [r, g, b] = pixelAt(result.files[0], 1, 300, 220);
    assert.ok(r > 90 && r < 170 && g < 40 && b < 40, `颜色 ${r},${g},${b}`);
    assertColor(pixelAt(result.files[0], 1, 260, 220), [0, 0, 0]);
  } finally {
    await ctx.cleanup();
  }
});

test('watermark：文字和图片同时绘制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    watermark,
    { file: [black], image: [red] },
    { text: 'BOTH', position: 'bottom-right', imagePosition: 'top-left', fontColor: 'white' },
  );
  try {
    assertColor(pixelAt(result.files[0], 1, 20, 20), [255, 0, 0], 60);
    assert.ok(fs.existsSync(path.join(ctx.workDir, 'wm.txt')));
  } finally {
    await ctx.cleanup();
  }
});

test('watermark：奇数尺寸补成偶数，PCM 音轨转 AAC', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(watermark, { file: [oddPcm] }, { text: 'odd' });
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.equal(info.video?.pixFmt, 'yuv420p');
    assert.equal(info.audio?.codec, 'aac');
  } finally {
    await ctx.cleanup();
  }
});

test(
  'watermark：水印文件扩展名不可信时按内容识别，视频当水印不拉长输出',
  { skip: ffmpegSkip },
  async () => {
    // URL 下载的文件可能没有正确的扩展名
    const logo = path.join(dir, 'logo.dat');
    fs.copyFileSync(red, logo);
    const still = await runOperation(watermark, { file: [black], image: [logo] }, { margin: '0' });
    try {
      assertColor(pixelAt(still.result.files[0], 1, 300, 220), [255, 0, 0], 60);
    } finally {
      await still.ctx.cleanup();
    }

    // 30 秒的视频叠在 3 秒的视频上：输出仍是 3 秒
    const moving = await runOperation(
      watermark,
      { file: [black], image: [long] },
      { imageWidth: '80', position: 'center' },
    );
    try {
      const info = await probeMedia(moving.result.files[0]);
      assert.ok(Math.abs(info.duration - 3) < 0.2, `时长 ${info.duration}`);
    } finally {
      await moving.ctx.cleanup();
    }
  },
);

/** 输出画面的像素宽高比，没有写时按 1:1 */
async function sarOf(file: string): Promise<string> {
  const raw = await probeRaw(file);
  const streams = (raw.streams ?? []) as { codec_type?: string; sample_aspect_ratio?: string }[];
  const sar = streams.find((s) => s.codec_type === 'video')?.sample_aspect_ratio;
  return !sar || sar === '0:1' || sar === 'N/A' ? '1:1' : sar;
}

test('watermark：存储宽度为奇数的变形宽银幕也能编码', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(watermark, { file: [anamorphicOdd] }, { text: 'sar' });
  try {
    // SAR 2:3 先拉正成显示尺寸（宽约 214，取偶数）x240 的正方形像素，文字不会被拉伸
    const info = await probeMedia(result.files[0]);
    const width = info.video?.width ?? 0;
    assert.ok(Math.abs(width - 214) <= 2 && width % 2 === 0, `宽度 ${width}`);
    assert.equal(info.video?.height, 240);
    assert.equal(await sarOf(result.files[0]), '1:1');
  } finally {
    await ctx.cleanup();
  }
});

test(
  'watermark：变形宽银幕上 imageScale 按显示宽度计算，图片不被横向拉伸',
  { skip: ffmpegSkip },
  async () => {
    // 存储 320x240、SAR 2:1，显示为 640x240；imageScale=0.25 → 显示宽度的 1/4 = 160，40x40 的图放大成 160x160
    const { result, ctx } = await runOperation(
      watermark,
      { file: [anamorphicBlack], image: [red] },
      { imageScale: '0.25', position: 'top-left', margin: '10' },
    );
    try {
      const out = result.files[0];
      const info = await probeMedia(out);
      assert.equal(info.video?.width, 640);
      assert.equal(info.video?.height, 240);
      assert.equal(await sarOf(out), '1:1');
      // 红块从 (10,10) 到 (170,170)，是正方形
      assertColor(pixelAt(out, 1, 160, 160), [255, 0, 0], 60);
      assertColor(pixelAt(out, 1, 20, 160), [255, 0, 0], 60);
      assertColor(pixelAt(out, 1, 180, 100), [0, 0, 0]);
      assertColor(pixelAt(out, 1, 100, 180), [0, 0, 0]);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('watermark：水印图片过大或缩放后过大时报错', { skip: ffmpegSkip }, async () => {
  await runFails(
    watermark,
    { file: [video], image: [hugeLogo] },
    {},
    /水印图片分辨率 8000x16 超过上限/,
  );
  // 40x40 的图缩放到 7680 宽：7680x7680 超过总像素上限
  await runFails(
    watermark,
    { file: [video], image: [red] },
    { imageWidth: '7680' },
    /缩放后的水印图片尺寸 7680x7680 超过上限/,
  );
});

test('watermark：没有音轨的视频，输出也没有音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    watermark,
    { file: [silent] },
    { text: 'silent', position: 'center' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(info.video);
    assert.equal(info.audio, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('watermark：特殊字符原样绘制，不会注入滤镜', { skip: ffmpegSkip }, async () => {
  const text = "it's 100% %{pts} a:b\\c,d;[e]\r\n第二行";
  const { result, ctx } = await runOperation(
    watermark,
    { file: [silent] },
    { text, borderWidth: 2, shadowColor: 'black@0.6', motion: 'scroll', speed: 200 },
  );
  try {
    assert.ok(fs.statSync(result.files[0]).size > 0);
    assert.equal(
      fs.readFileSync(path.join(ctx.workDir, 'wm.txt'), 'utf8'),
      "it's 100% %{pts} a:b\\c,d;[e]\n第二行",
    );
  } finally {
    await ctx.cleanup();
  }
});

test('watermark：bounce 运动时水印位置随时间变化', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    watermark,
    { file: [black], image: [red] },
    { motion: 'bounce', speed: '100', margin: '0', position: 'top-left' },
  );
  try {
    // t=0 在左上角；t=1 已横向移动约 100 像素
    assertColor(pixelAt(result.files[0], 0, 20, 20), [255, 0, 0], 60);
    assertColor(pixelAt(result.files[0], 1, 20, 20), [0, 0, 0]);
  } finally {
    await ctx.cleanup();
  }
});

test('watermark：参数校验', () => {
  assert.deepEqual(paramErrors(watermark, {}), ['请提供 text 文字或上传 image 图片']);
  assert.deepEqual(paramErrors(watermark, { text: '   ' }), ['请提供 text 文字或上传 image 图片']);
  assert.deepEqual(paramErrors(watermark, {}, { file: 1, image: 1 }), []);
  // 旧版直接把 fontColor 拼进滤镜，可以注入任意滤镜参数
  const injected = paramErrors(watermark, { text: 'a', fontColor: "white:x=0'[out]" });
  assert.match(injected[0], /fontColor 必须是颜色名/);
  assert.match(paramErrors(watermark, { text: 'a', position: 'middle' })[0], /position 只能是/);
  assert.match(paramErrors(watermark, { text: 'a', opacity: '1.5' })[0], /opacity 必须是 0 到 1/);
  assert.deepEqual(
    paramErrors(watermark, { imageWidth: 100, imageScale: 0.2 }, { file: 1, image: 1 }),
    ['imageWidth 和 imageScale 只能指定一个'],
  );
  assert.deepEqual(paramErrors(watermark, { text: 'a', startTime: '5', endTime: '00:00:03' }), [
    '结束时间 endTime 必须大于开始时间 startTime',
  ]);
  assert.match(paramErrors(watermark, { text: 'x'.repeat(501) })[0], /最多 500 个字符/);
  assert.match(paramErrors(watermark, { text: 'a', fontSize: '0' })[0], /fontSize 必须是/);
  // 旧客户端的写法仍然有效
  assert.deepEqual(
    paramErrors(watermark, {
      text: 'Hello',
      position: 'top-right',
      fontSize: '36',
      fontColor: 'yellow',
    }),
    [],
  );
});

test('watermark：控制字符清理', () => {
  assert.equal(cleanWatermarkText('\n\na\u0000b\u0007\r\nc\n'), 'ab\nc');
});

test('watermark：纯音频输入给出明确错误', { skip: ffmpegSkip }, async () => {
  await runFails(watermark, { file: [audioOnly] }, { text: 'a' }, /视频不包含视频画面/);
});

test('watermark：水印图片无法解析时报错', { skip: ffmpegSkip }, async () => {
  const bogus = path.join(dir, 'bogus.png');
  fs.writeFileSync(bogus, 'not an image');
  await runFails(watermark, { file: [video], image: [bogus] }, {}, /水印图片无法解析/);
});

test('watermark：取消任务会终止 ffmpeg', { skip: ffmpegSkip }, async () => {
  const controller = new AbortController();
  const params = watermark.params.parse({ text: 'cancel', motion: 'bounce' });
  const ctx = createTestContext({ file: [long] }, { signal: controller.signal });
  try {
    const started = Date.now();
    const running = watermark.run(ctx, params);
    setTimeout(() => controller.abort(new Error('任务已取消')), 300);
    await assert.rejects(running, /任务已取消/);
    assert.ok(Date.now() - started < 5000);
  } finally {
    await ctx.cleanup();
  }
});
