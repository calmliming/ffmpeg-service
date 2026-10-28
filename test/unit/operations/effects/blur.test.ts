import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { config } from '../../../../src/config';
import { blur, maxBoxblurRadius, regionFilter } from '../../../../src/operations/effects/blur';
import { probeMedia } from '../../../../src/utils/media-probe';
import { psnr } from './fixtures';

let dir = '';
let video = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-blur-');
  video = makeVideo(dir, 'in.mp4', { size: '320x240', duration: 2 });
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('blur：只模糊指定区域，区域外保持原样，音轨保留', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    blur,
    { file: [video] },
    { regions: '[{"x":40,"y":30,"width":120,"height":80}]', strength: '50' },
  );
  try {
    const out = result.files[0];
    assert.match(out, /\.mp4$/);
    const info = await probeMedia(out);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.ok(Math.abs(info.duration - 2) < 0.15, `duration ${info.duration}`);
    assert.equal(info.audio?.codec, 'aac');
    // 区域内画面明显变化，区域外只有重新编码的损失
    assert.ok(psnr(video, out, '120:80:40:30') < 30, '区域内应被模糊');
    assert.ok(psnr(video, out, '120:100:200:140') > 35, '区域外应保持原样');
    assert.ok(ctx.progressCalls.at(-1)?.fraction === 1);
  } finally {
    await ctx.cleanup();
  }
});

test('blur：马赛克 + 百分比坐标 + 区域自己的时间段', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    blur,
    { file: [video] },
    {
      regions: [{ x: 50, y: 50, width: 50, height: 50, startTime: 1 }],
      unit: 'percent',
      mode: 'mosaic',
      strength: 40,
    },
  );
  try {
    const out = result.files[0];
    const head = path.join(dir, 'mosaic-head.mp4');
    const tail = path.join(dir, 'mosaic-tail.mp4');
    generate(['-i', out, '-t', '0.8', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', head]);
    generate(['-ss', '1.2', '-i', out, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', tail]);
    const srcHead = path.join(dir, 'src-head.mp4');
    const srcTail = path.join(dir, 'src-tail.mp4');
    generate(['-i', video, '-t', '0.8', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', srcHead]);
    generate([
      '-ss',
      '1.2',
      '-i',
      video,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      srcTail,
    ]);
    // 第 1 秒前右下四分之一不变，之后被打码
    assert.ok(psnr(srcHead, head, '160:120:160:120') > 30, '开始时间前不应处理');
    assert.ok(psnr(srcTail, tail, '160:120:160:120') < 25, '开始时间后应被打码');
  } finally {
    await ctx.cleanup();
  }
});

test('blur：不传区域时处理整个画面；无音轨输入不产生音轨', { skip: ffmpegSkip }, async () => {
  const silent = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
  const { result, ctx } = await runOperation(blur, { file: [silent] }, { strength: 20 });
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.audio, undefined);
    assert.equal(info.video?.width, 320);
    assert.ok(psnr(silent, result.files[0]) < 25);
  } finally {
    await ctx.cleanup();
  }
});

test('blur：奇数宽高、旋转视频和超出画面的区域', { skip: ffmpegSkip }, async () => {
  // yuv444p 才能编码奇数尺寸的 H.264
  const odd = path.join(dir, 'odd.mkv');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=321x241:rate=25:duration=1,format=yuv444p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv444p',
    odd,
  ]);
  const a = await runOperation(blur, { file: [odd] }, { regions: '300,200,100,100' });
  try {
    const info = await probeMedia(a.result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
  } finally {
    await a.ctx.cleanup();
  }

  const rotated = path.join(dir, 'rotated.mp4');
  generate(['-display_rotation', '90', '-i', video, '-c', 'copy', rotated]);
  // 显示尺寸是 240x320，y=250 的区域只有在按旋转后的尺寸计算时才在画面内
  const b = await runOperation(blur, { file: [rotated] }, { regions: [[10, 250, 100, 60]] });
  try {
    const info = await probeMedia(b.result.files[0]);
    assert.equal(info.video?.width, 240);
    assert.equal(info.video?.height, 320);
  } finally {
    await b.ctx.cleanup();
  }

  await assert.rejects(
    runOperation(blur, { file: [video] }, { regions: [[400, 10, 50, 50]] }),
    /第 1 个区域完全在画面（320x240）之外/,
  );
  await assert.rejects(
    runOperation(blur, { file: [video] }, { regions: [[10, 10, 50, 50]], startTime: 5 }),
    /开始时间（5 秒）超出视频时长/,
  );
});

test('blur：boxblur 半径在亮度和色度平面上都合法（FFmpeg 真跑）', { skip: ffmpegSkip }, () => {
  // 半径必须 < 平面短边的一半，yuv420p 色度平面只有一半大小；4 像素是区域被扩大到的最小边长
  const sizes: [number, number][] = [
    [4, 4],
    [4, 640],
    [640, 4],
    [6, 6],
    [8, 8],
    [20, 20],
    [100, 100],
    [100, 6],
    [640, 360],
    [1280, 720],
    [720, 1280],
    [1920, 1080],
  ];
  const strengths = [1, 30, 63, 70, 85, 90, 97, 100];
  for (const [w, h] of sizes) {
    // boxblur 不改尺寸，串在一起每个滤镜都会按同一个画面尺寸校验半径
    const chain = strengths.map((s) => regionFilter('blur', s, w, h)).join(',');
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
        `color=s=${w}x${h}:r=25:d=0.04,format=yuv420p`,
        '-vf',
        chain,
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
  // 强度映射不变（区域短边一半的百分比），只在半径上限处夹住
  assert.equal(
    regionFilter('blur', 30, 100, 100),
    'boxblur=luma_radius=15:luma_power=2:chroma_radius=8:chroma_power=2',
  );
  assert.equal(
    regionFilter('blur', 100, 100, 100),
    'boxblur=luma_radius=49:luma_power=2:chroma_radius=24:chroma_power=2',
  );
  assert.equal(
    regionFilter('blur', 100, 4, 4),
    'boxblur=luma_radius=1:luma_power=2:chroma_radius=0:chroma_power=2',
  );
  assert.equal(maxBoxblurRadius(2), 0);
  assert.equal(maxBoxblurRadius(3), 1);
  assert.equal(maxBoxblurRadius(50), 24);
});

test('blur：强度 100、4 像素小区域和细长区域都能处理', { skip: ffmpegSkip }, async () => {
  // 整个画面 + 强度 100：半径正好等于短边一半时 FFmpeg 报 Invalid argument
  const full = await runOperation(blur, { file: [video] }, { strength: 100 });
  try {
    const info = await probeMedia(full.result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.ok(psnr(video, full.result.files[0]) < 25, '整个画面应被模糊');
  } finally {
    await full.ctx.cleanup();
  }
  // 1x1 → 扩大到 4x4、高 4 像素的细条、8 / 20 / 100 像素的方块，默认强度和强度 100 都要能跑
  const regions = '319,239,1,1;0,100,320,4;10,10,8,8;30,30,20,20;150,20,100,100';
  for (const strength of [30, 100]) {
    const { result, ctx } = await runOperation(blur, { file: [video] }, { regions, strength });
    try {
      const info = await probeMedia(result.files[0]);
      assert.equal(info.video?.height, 240);
      assert.ok(psnr(video, result.files[0], '100:100:150:20') < 30, '大区域应被模糊');
    } finally {
      await ctx.cleanup();
    }
  }
});

test('blur：纯音频输入返回明确错误', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'a.m4a', { duration: 1 });
  await assert.rejects(runOperation(blur, { file: [audio] }, {}), /输入文件不包含视频画面/);
});

test('blur：参数校验', () => {
  const many = Array.from({ length: 11 }, () => '0,0,10,10').join(';');
  assert.deepEqual(paramErrors(blur, { regions: many }), ['regions 最多 10 个区域']);
  assert.deepEqual(paramErrors(blur, { regions: '[{"x":1' }), ['regions 不是合法的 JSON']);
  assert.deepEqual(paramErrors(blur, { strength: '0' }), ['strength 必须是 1 到 100 之间的数字']);
  assert.deepEqual(paramErrors(blur, { mode: 'pixel' }), ['mode 只能是 blur / mosaic']);
  assert.deepEqual(paramErrors(blur, { startTime: 3, endTime: 2 }), ['endTime 必须大于 startTime']);
  assert.deepEqual(paramErrors(blur, { regions: '', strength: '' }), []);
});
