import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waveformOperation, waveformRate } from '../../../../src/operations/audio/waveform';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { makeExprAudio, pixelAt, withoutExtension } from './audio-helpers';

let dir = '';
let swell = '';
let video = '';
let silentVideo = '';

/** 需要人工看图时设置 FFSVC_KEEP_IMAGES=目录，把生成的 PNG 复制出来 */
function keepImage(file: string, name: string): void {
  const target = process.env.FFSVC_KEEP_IMAGES;
  if (target) fs.copyFileSync(file, path.join(target, name));
}

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-waveform-');
  // 音量从小到大再变小，左声道 440 Hz、右声道 330 Hz 且只有一半音量
  swell = withoutExtension(
    makeExprAudio(
      dir,
      'swell.flac',
      'sin(PI*t/3)*sin(2*PI*440*t)|0.5*sin(PI*t/3)*sin(2*PI*330*t)',
      3,
    ),
  );
  video = makeVideo(dir, 'clip.mp4', { duration: 1 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('默认 1200x240 的 RGB PNG', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(waveformOperation, { file: [swell] }, {});
  try {
    assert.equal(result.files.length, 1);
    assert.equal(path.extname(result.files[0]), '.png');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 1200);
    assert.equal(info.video?.height, 240);
    assert.equal(info.video?.pixFmt, 'rgb24');
    assert.deepEqual(result.data, { width: 1200, height: 240 });
    // 波形是纯色（不发灰），背景是白色
    assert.deepEqual(pixelAt(result.files[0], 600, 120), [0x3b, 0x82, 0xf6, 255]);
    assert.deepEqual(pixelAt(result.files[0], 600, 2), [255, 255, 255, 255]);
    keepImage(result.files[0], 'waveform-default.png');
  } finally {
    await ctx.cleanup();
  }
});

test('透明背景、分声道、自定义颜色和刻度', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    waveformOperation,
    { file: [swell] },
    {
      size: '800x300',
      color: '#FF5500',
      transparent: 'true',
      mode: 'split',
      scale: 'sqrt',
      amplitude: 'peak',
    },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 800);
    assert.equal(info.video?.height, 300);
    assert.equal(info.video?.pixFmt, 'rgba');
    assert.deepEqual(pixelAt(result.files[0], 400, 75), [0xff, 0x55, 0x00, 255]);
    assert.equal(pixelAt(result.files[0], 400, 150)[3], 0, '两个声道之间透明');
    keepImage(result.files[0], 'waveform-split.png');
  } finally {
    await ctx.cleanup();
  }
});

test('自定义背景色；视频输入取音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    waveformOperation,
    { file: [video] },
    {
      backgroundColor: 'black',
      color: 'lime@0.8',
      size: '320x80',
    },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 80);
  } finally {
    await ctx.cleanup();
  }
});

test('没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  await assert.rejects(runOperation(waveformOperation, { file: [silentVideo] }, {}), /没有音轨/);
});

test('长音频先降采样，短音频不变', () => {
  assert.equal(waveformRate(60, 48000), undefined);
  assert.equal(waveformRate(3600, 48000), 8000);
  assert.equal(waveformRate(3 * 3600, 44100), 2666);
  assert.equal(waveformRate(0, 48000), undefined);
});

test('参数校验', () => {
  assert.match(paramErrors(waveformOperation, { size: '8000x100' })[0], /size 最大 7680x4320/);
  assert.match(paramErrors(waveformOperation, { size: 'big' })[0], /size 必须是 宽x高 格式/);
  assert.match(paramErrors(waveformOperation, { color: 'red;drop' })[0], /color 必须是颜色名/);
  assert.match(
    paramErrors(waveformOperation, { mode: 'stack' })[0],
    /mode 只能是 combined \/ split/,
  );
  assert.match(
    paramErrors(waveformOperation, { scale: 'db' })[0],
    /scale 只能是 lin \/ log \/ sqrt \/ cbrt/,
  );
  assert.deepEqual(
    paramErrors(waveformOperation, { transparent: true, backgroundColor: 'white' }),
    ['transparent 和 backgroundColor 只能设置其中一个'],
  );
  assert.deepEqual(paramErrors(waveformOperation, { size: '1920x1080', color: '0x112233' }), []);
});
