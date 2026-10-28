import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spectrogramOperation } from '../../../../src/operations/audio/spectrogram';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { makeExprAudio } from './audio-helpers';

let dir = '';
let sweep = '';
let lowRate = '';
let silentVideo = '';

/** 需要人工看图时设置 FFSVC_KEEP_IMAGES=目录，把生成的 PNG 复制出来 */
function keepImage(file: string, name: string): void {
  const target = process.env.FFSVC_KEEP_IMAGES;
  if (target) fs.copyFileSync(file, path.join(target, name));
}

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-spectrogram-');
  // 3 秒内从 200 Hz 扫到约 5 kHz 的扫频音，频谱图上是一条上升的线
  sweep = makeExprAudio(dir, 'sweep.wav', '0.5*sin(2*PI*(200*t+800*t*t))', 3, 22050);
  lowRate = makeAudio(dir, 'low.wav', { duration: 1, sampleRate: 8000 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('legend=false 时图片尺寸与 size 一致', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    spectrogramOperation,
    { file: [sweep] },
    {
      legend: 'false',
      size: '640x320',
      colorScheme: 'magma',
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.png');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 640);
    assert.equal(info.video?.height, 320);
    assert.deepEqual(result.data, { width: 640, height: 320, legend: false });
    keepImage(result.files[0], 'spectrogram-nolegend.png');
  } finally {
    await ctx.cleanup();
  }
});

test('默认带图例：整张图比 size 大，data 返回实际尺寸', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    spectrogramOperation,
    { file: [sweep] },
    {
      frequencyScale: 'log',
      maxFrequency: 8000,
    },
  );
  try {
    const info = await probeMedia(result.files[0]);
    const data = result.data as { width: number; height: number; legend: boolean };
    assert.equal(data.legend, true);
    assert.equal(data.width, info.video?.width);
    assert.equal(data.height, info.video?.height);
    assert.ok(data.width > 1200 && data.height > 600, `${data.width}x${data.height}`);
    keepImage(result.files[0], 'spectrogram-legend.png');
  } finally {
    await ctx.cleanup();
  }
});

test('分声道画图', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    spectrogramOperation,
    { file: [lowRate] },
    {
      mode: 'separate',
      colorScheme: 'channel',
      legend: false,
      size: '400x200',
      scale: 'sqrt',
      dynamicRange: 90,
    },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 400);
    assert.equal(info.video?.height, 200);
  } finally {
    await ctx.cleanup();
  }
});

test('频率超过奈奎斯特频率、没有音轨时给出明确错误', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(spectrogramOperation, { file: [lowRate] }, { maxFrequency: 6000 }),
    /maxFrequency（6000 Hz）超过了输入采样率的一半（4000 Hz）/,
  );
  await assert.rejects(
    runOperation(spectrogramOperation, { file: [lowRate] }, { minFrequency: 5000 }),
    /minFrequency（5000 Hz）必须低于输入采样率的一半（4000 Hz）/,
  );
  await assert.rejects(runOperation(spectrogramOperation, { file: [silentVideo] }, {}), /没有音轨/);
});

test('参数校验', () => {
  assert.match(
    paramErrors(spectrogramOperation, { colorScheme: 'jet' })[0],
    /colorScheme 只能是 channel \/ intensity/,
  );
  assert.match(paramErrors(spectrogramOperation, { scale: 'db' })[0], /scale 只能是 lin/);
  assert.match(paramErrors(spectrogramOperation, { size: '7681x100' })[0], /size 最大 7680x4320/);
  assert.match(
    paramErrors(spectrogramOperation, { dynamicRange: 5 })[0],
    /dynamicRange 必须是 10 到 200 之间的数字/,
  );
  assert.deepEqual(paramErrors(spectrogramOperation, { minFrequency: 5000, maxFrequency: 4000 }), [
    'maxFrequency 必须大于 minFrequency',
  ]);
  assert.deepEqual(
    paramErrors(spectrogramOperation, { legend: '0', frequencyScale: 'LOG', minFrequency: '100' }),
    [],
  );
});
