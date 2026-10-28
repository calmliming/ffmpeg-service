import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fadeOperation } from '../../../../src/operations/timeline/fade';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { frameLuma, makeRampVideo, meanVolumeDb, near } from './helpers';

let dir = '';
let video = '';
let silent = '';
/** 画面 3 秒、声音只有 2 秒：淡出要按各自的结尾计算 */
let shortAudio = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-fade-');
  video = makeVideo(dir, 'v.mp4', { duration: 3 });
  silent = makeVideo(dir, 'silent.mp4', { duration: 2, audio: false });
  shortAudio = makeRampVideo(dir, 'short-audio.mp4', {
    duration: 3,
    slope: 0,
    toneUntil: 10,
    audioDuration: 2,
  });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(fadeOperation, {}), ['fadeIn 和 fadeOut 至少要有一个大于 0']);
  assert.deepEqual(paramErrors(fadeOperation, { fadeIn: 0, fadeOut: '0' }), [
    'fadeIn 和 fadeOut 至少要有一个大于 0',
  ]);
  assert.deepEqual(paramErrors(fadeOperation, { fadeIn: 61 }), [
    'fadeIn 必须是 0 到 60 之间的数字',
  ]);
  assert.deepEqual(paramErrors(fadeOperation, { fadeIn: 1, color: 'not-a-color' }), [
    'color 必须是颜色名（如 white）、#RRGGBB 或 #RRGGBBAA，可带 @透明度（如 white@0.5）',
  ]);
  assert.deepEqual(paramErrors(fadeOperation, { fadeIn: 1, curve: 'zigzag' }), [
    'curve 只能是 tri / qsin / hsin / esin / log / ipar / qua / cub / squ / cbr / par / exp',
  ]);
  assert.deepEqual(paramErrors(fadeOperation, { audioFadeOut: 1 }), []);
});

test('黑场淡入 + 淡出，声音同步', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fadeOperation,
    { file: [video] },
    { fadeIn: '1', fadeOut: '1' },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.ok(near(info.duration, 3, 0.1), `时长 ${info.duration}`);
    assert.ok(info.video && info.audio);
    assert.ok(frameLuma(out, 0) < 25, `第一帧应接近黑色: ${frameLuma(out, 0)}`);
    assert.ok(frameLuma(out, 1.5) > 60, '中间应正常亮度');
    assert.ok(frameLuma(out, 2.96) < 25, '最后一帧应接近黑色');
    // 淡入的前 0.1 秒几乎无声，中间正常
    assert.ok(meanVolumeDb(out, 0, 0.1) < meanVolumeDb(out, 1.2, 0.5) - 15);
  } finally {
    await ctx.cleanup();
  }
});

test('白场淡入；audio=false 时声音流复制', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fadeOperation,
    { file: [video] },
    { fadeIn: 2, color: 'white', audio: 'false' },
  );
  try {
    const out = result.files[0];
    assert.ok(frameLuma(out, 0) > 230, `第一帧应接近白色: ${frameLuma(out, 0)}`);
    // 原声音没有淡入
    assert.ok(meanVolumeDb(out, 0, 0.2) > -40);
  } finally {
    await ctx.cleanup();
  }
});

test('只淡声音时画面流复制；声音按音轨自己的时长淡出', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    fadeOperation,
    { file: [shortAudio] },
    { audioFadeOut: 0.5 },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.video?.codec, 'h264');
    // 音轨 2 秒：1.5 秒之前不受影响，1.9 秒以后几乎无声
    assert.ok(meanVolumeDb(out, 1, 0.4) > -40);
    assert.ok(meanVolumeDb(out, 1.92, 0.08) < meanVolumeDb(out, 1, 0.4) - 15);
  } finally {
    await ctx.cleanup();
  }
});

test('没有音轨的视频、纯音频文件', { skip: ffmpegSkip }, async () => {
  const noAudio = await runOperation(fadeOperation, { file: [silent] }, { fadeOut: 1 });
  try {
    const info = await probeMedia(noAudio.result.files[0]);
    assert.equal(info.audio, undefined);
    assert.ok(near(info.duration, 2, 0.1));
  } finally {
    await noAudio.ctx.cleanup();
  }

  const wav = makeAudio(dir, 'a.wav', { duration: 2 });
  const audioOnly = await runOperation(
    fadeOperation,
    { file: [wav] },
    { fadeIn: 0.5, fadeOut: 0.5, curve: 'qsin' },
  );
  try {
    assert.ok(audioOnly.result.files[0].endsWith('.m4a'));
    const info = await probeMedia(audioOnly.result.files[0]);
    assert.equal(info.video, undefined);
  } finally {
    await audioOnly.ctx.cleanup();
  }
  await assert.rejects(
    runOperation(fadeOperation, { file: [wav] }, { fadeIn: 1, audio: false }),
    /纯音频文件只能淡入淡出声音/,
  );
});

test('淡入 + 淡出超过时长时报错', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(fadeOperation, { file: [silent] }, { fadeIn: 1.5, fadeOut: 1 }),
    /淡入 1.5 秒 \+ 淡出 1 秒超过了视频时长 2 秒/,
  );
});
