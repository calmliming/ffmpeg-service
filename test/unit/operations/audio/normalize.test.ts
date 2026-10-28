import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeOperation } from '../../../../src/operations/audio/normalize';
import {
  containerProblem,
  normalizeVideoAudioOperation,
  pickContainer,
} from '../../../../src/operations/audio/normalize-video';
import { applyFilter, parseLoudnormJson } from '../../../../src/operations/audio/loudnorm';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, makeExprAudio } from './audio-helpers';

interface NormalizeData {
  target: { i: number; tp: number; lra: number };
  input: { i: number; tp: number; lra: number; thresh: number };
  output: { i: number; tp: number; lra: number; thresh: number };
  normalizationType: string;
  format?: string;
}

let dir = '';
let quiet = '';
let video = '';
let silentVideo = '';
let silence = '';
let long = '';
let short = '';
let vp9 = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-normalize-');
  quiet = makeAudio(dir, 'quiet.wav', { duration: 3, volume: 0.05 });
  video = makeVideo(dir, 'clip.mp4', { duration: 2 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
  silence = makeExprAudio(dir, 'silence.wav', '0', 1);
  long = makeExprAudio(dir, 'long.wav', 'sin(2*PI*330*t)*0.3', 120, 8000);
  // 0.3 秒、-18 dBFS 的音效，不够一个 400 毫秒的 EBU R128 测量块
  short = makeAudio(dir, 'short.wav', { duration: 0.3 });
  vp9 = path.join(dir, 'vp9.webm');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x64:rate=10:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-c:a',
    'libopus',
    vp9,
  ]);
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('两遍 loudnorm 把小声的音频拉到目标响度，采样率还原', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    normalizeOperation,
    { file: [quiet] },
    {
      targetLufs: '-16',
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.wav');
    const data = result.data as NormalizeData;
    assert.deepEqual(data.target, { i: -16, tp: -1, lra: 11 });
    assert.ok(data.input.i < -30, `原始响度 ${data.input.i}`);
    assertNear(data.output.i, -16, 1.5, 'output.i');
    assert.ok(data.output.tp <= -0.5, `真峰值 ${data.output.tp}`);
    assert.equal(data.normalizationType, 'linear');
    const info = await probeMedia(result.files[0]);
    // loudnorm 内部是 192 kHz，必须还原
    assert.equal(info.audio?.sampleRate, 44100);
    assertNear(info.duration, 3, 0.1, 'duration');
    const phases = ctx.progressCalls.map((c) => c.extra?.phase).filter(Boolean);
    assert.deepEqual(phases, ['analyzing', 'processing']);
    assert.equal(ctx.progressCalls[ctx.progressCalls.length - 1].fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('视频响度标准化：画面直接复制，音轨重新编码', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(normalizeVideoAudioOperation, { file: [video] }, {});
  try {
    assert.equal(path.extname(result.files[0]), '.mp4');
    const data = result.data as NormalizeData;
    assert.equal(data.format, 'mp4');
    assertNear(data.output.i, -14, 1.5, 'output.i');
    const [before, after] = await Promise.all([probeMedia(video), probeMedia(result.files[0])]);
    assert.equal(after.video?.codec, 'h264');
    assert.equal(after.video?.width, 320);
    assert.equal(after.video?.height, 240);
    assert.equal(after.video?.frameRate, before.video?.frameRate);
    assert.equal(after.audio?.codec, 'aac');
    assertNear(after.duration, before.duration, 0.1, 'duration');
  } finally {
    await ctx.cleanup();
  }
});

test('视频响度标准化可以指定 mkv，不兼容的容器给出明确错误', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    normalizeVideoAudioOperation,
    { file: [video] },
    {
      format: 'mkv',
      audioBitrate: '128k',
    },
  );
  try {
    assert.equal(path.extname(result.files[0]), '.mkv');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.codec, 'h264');
  } finally {
    await ctx.cleanup();
  }
  await assert.rejects(
    runOperation(normalizeVideoAudioOperation, { file: [video] }, { format: 'webm' }),
    /视频编码 h264 不能直接复制进 webm 容器/,
  );
});

test('视频响度标准化拒绝纯音频和没有音轨的视频', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(normalizeVideoAudioOperation, { file: [quiet] }, {}),
    /输入文件没有视频画面/,
  );
  await assert.rejects(
    runOperation(normalizeVideoAudioOperation, { file: [silentVideo] }, {}),
    /输入视频没有音轨/,
  );
});

test('静音输入无法标准化', { skip: ffmpegSkip }, async () => {
  await assert.rejects(runOperation(normalizeOperation, { file: [silence] }, {}), /几乎是静音/);
});

test('短于 0.4 秒的音频给出真实原因，而不是说它是静音', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(normalizeOperation, { file: [short] }, {}),
    /音频只有 0\.3 秒，短于 0\.4 秒，无法按 EBU R128 测量综合响度/,
  );
});

test('VP9 视频指定 mov 时在测量之前直接拒绝', { skip: ffmpegSkip }, async () => {
  // mov 封装器不接受 VP9 / AV1（只能放进 mp4），之前会跑完测量再报一串看不懂的 FFmpeg 错误
  await assert.rejects(
    runOperation(normalizeVideoAudioOperation, { file: [vp9] }, { format: 'mov' }),
    /视频编码 vp9 不能直接复制进 mov 容器.*请改用 mkv/,
  );
});

test('取消任务会杀掉 ffmpeg，并原样抛出取消原因', { skip: ffmpegSkip }, async () => {
  const controller = new AbortController();
  const reason = new Error('任务已取消');
  const timer = setTimeout(() => controller.abort(reason), 300);
  try {
    await assert.rejects(
      runOperation(normalizeOperation, { file: [long] }, {}, { signal: controller.signal }),
      (err) => err === reason,
    );
  } finally {
    clearTimeout(timer);
  }
});

test('解析 loudnorm 的 JSON，-inf 转成 -Infinity；第二遍滤镜只用数字', () => {
  const stderr = [
    '[Parsed_loudnorm_0 @ 0000] ',
    '{',
    '\t"input_i" : "-35.75",',
    '\t"input_tp" : "-inf",',
    '\t"input_lra" : "0.00",',
    '\t"input_thresh" : "-45.75",',
    '\t"output_i" : "-13.95",',
    '\t"output_tp" : "-13.28",',
    '\t"output_lra" : "0.00",',
    '\t"output_thresh" : "-23.95",',
    '\t"normalization_type" : "dynamic",',
    '\t"target_offset" : "-0.05"',
    '}',
  ].join('\n');
  const report = parseLoudnormJson(stderr);
  assert.equal(report.input.i, -35.75);
  assert.equal(report.input.tp, Number.NEGATIVE_INFINITY);
  assert.equal(report.normalizationType, 'dynamic');
  assert.equal(
    applyFilter({ i: -14, tp: -1, lra: 11 }, report),
    'loudnorm=I=-14:TP=-1:LRA=11:measured_I=-35.75:measured_TP=-99:measured_LRA=0.01:' +
      'measured_thresh=-45.75:offset=-0.05:linear=true:print_format=json',
  );
  assert.throws(() => parseLoudnormJson('no json'), /没有拿到 loudnorm 的测量结果/);
});

test('pickContainer 沿用输入容器，编码放不进去时退回 mkv', () => {
  const raw = (name: string, brand?: string, audio = 'aac') => ({
    format: { format_name: name, tags: brand ? { major_brand: brand } : {} },
    streams: [{ codec_type: 'audio', codec_name: audio }],
  });
  const mp4 = 'mov,mp4,m4a,3gp,3g2,mj2';
  assert.equal(pickContainer(raw(mp4, 'isom'), 'h264'), 'mp4');
  assert.equal(pickContainer(raw(mp4, 'qt  '), 'h264'), 'mov');
  assert.equal(pickContainer(raw(mp4, 'qt  '), 'prores'), 'mov');
  assert.equal(pickContainer(raw(mp4, 'isom'), 'prores'), 'mov');
  assert.equal(pickContainer(raw('matroska,webm', undefined, 'opus'), 'vp9'), 'webm');
  assert.equal(pickContainer(raw('matroska,webm', undefined, 'aac'), 'vp9'), 'mkv');
  assert.equal(pickContainer(raw('avi'), 'h264'), 'mp4');
  assert.equal(pickContainer(raw('flv'), 'flv1'), 'mkv');
  assert.equal(containerProblem('mkv', 'flv1'), undefined);
  assert.match(containerProblem('mp4', 'prores') ?? '', /prores 不能直接复制进 mp4/);
  // mov 封装器拒绝 VP9 / AV1：qt 品牌的文件里是这两种编码时改用 mp4
  assert.equal(pickContainer(raw(mp4, 'qt  '), 'vp9'), 'mp4');
  assert.equal(pickContainer(raw(mp4, 'qt  '), 'av1'), 'mp4');
  assert.match(containerProblem('mov', 'vp9') ?? '', /vp9 不能直接复制进 mov/);
  assert.match(containerProblem('mov', 'av1') ?? '', /av1 不能直接复制进 mov/);
  assert.equal(containerProblem('mp4', 'av1'), undefined);
});

test('参数校验', () => {
  assert.match(
    paramErrors(normalizeOperation, { targetLufs: -80 })[0],
    /targetLufs 必须是 -70 到 -5 之间的数字/,
  );
  assert.match(
    paramErrors(normalizeOperation, { truePeak: 1 })[0],
    /truePeak 必须是 -9 到 0 之间的数字/,
  );
  assert.match(
    paramErrors(normalizeOperation, { lra: 'wide' })[0],
    /lra 必须是 1 到 50 之间的数字/,
  );
  assert.match(
    paramErrors(normalizeVideoAudioOperation, { format: 'avi' })[0],
    /format 只能是 mp4 \/ mkv \/ mov \/ webm/,
  );
  assert.deepEqual(paramErrors(normalizeOperation, { targetLufs: '-23', truePeak: '-2' }), []);
});
