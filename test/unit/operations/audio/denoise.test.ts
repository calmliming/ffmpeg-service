import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  denoiseOperation,
  parseRmsWindows,
  quietestSegment,
} from '../../../../src/operations/audio/denoise';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, bandVolume, volumeOf, withoutExtension } from './audio-helpers';

interface DenoiseData {
  strength: string;
  reduction: number;
  noiseFloor: number;
  measuredNoise: number | null;
  noiseProfile: 'sampled' | 'default';
  highpass: number | null;
  lowpass: number | null;
}

let dir = '';
let noise = '';
let speech = '';
let tone = '';
let lowRate = '';
let video = '';
let silentVideo = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-denoise-');
  // 约 -51 dBFS 的白噪声，接近真实录音的底噪。噪声固定种子：不固定时每次生成的噪声都不同，断言偶尔差一点过不了
  noise = path.join(dir, 'noise.wav');
  generate(['-f', 'lavfi', '-i', 'anoisesrc=d=2:c=white:r=44100:a=0.005:seed=1', noise]);
  // 0.5 秒有声、0.5 秒停顿交替的 440 Hz 音，叠加约 -48 dBFS 的粉红噪声
  speech = path.join(dir, 'speech.wav');
  generate([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.3*sin(2*PI*440*t)*lt(mod(t,1),0.5)':d=3:s=44100",
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=d=3:c=pink:r=44100:a=0.02:seed=1',
    '-filter_complex',
    '[0][1]amix=inputs=2:normalize=0',
    speech,
  ]);
  // 没有停顿的持续响音（类似音乐）：不能把它当成噪声
  tone = makeAudio(dir, 'tone.wav', { duration: 1, volume: 4 });
  lowRate = withoutExtension(makeAudio(dir, 'low.flac', { duration: 1, sampleRate: 16000 }));
  video = makeVideo(dir, 'clip.mp4', { duration: 1 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test(
  '自动测量底噪：strong 把白噪声压低 20 dB 以上，时长和格式不变',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      denoiseOperation,
      { file: [noise] },
      {
        strength: 'strong',
      },
    );
    try {
      assert.equal(path.extname(result.files[0]), '.wav');
      const info = await probeMedia(result.files[0]);
      assertNear(info.duration, 2, 0.01, 'duration');
      const before = volumeOf(noise).mean;
      const after = volumeOf(result.files[0]).mean;
      assert.ok(after < before - 20, `降噪前 ${before} dB，降噪后 ${after} dB`);
      const data = result.data as DenoiseData;
      assert.equal(data.noiseProfile, 'sampled');
      assertNear(data.measuredNoise ?? 0, -51, 2, 'measuredNoise');
      assert.equal(data.noiseFloor, Math.round((data.measuredNoise ?? 0) + 14));
      assert.equal(data.reduction, 30);
      const phases = ctx.progressCalls.map((c) => c.extra?.phase).filter(Boolean);
      assert.deepEqual(phases, ['analyzing', 'processing']);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('采样停顿里的粉红噪声：停顿变安静，有声部分基本不变', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(denoiseOperation, { file: [speech] }, {});
  try {
    const data = result.data as DenoiseData;
    assert.equal(data.strength, 'medium');
    assert.equal(data.noiseProfile, 'sampled');
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 3, 0.01, 'duration');
    const pauseBefore = volumeOf(speech, { start: 2.6, duration: 0.3 }).mean;
    const pauseAfter = volumeOf(result.files[0], { start: 2.6, duration: 0.3 }).mean;
    assert.ok(pauseAfter < pauseBefore - 6, `停顿：之前 ${pauseBefore} dB，之后 ${pauseAfter} dB`);
    const toneBefore = volumeOf(speech, { start: 2.1, duration: 0.3 }).mean;
    const toneAfter = volumeOf(result.files[0], { start: 2.1, duration: 0.3 }).mean;
    assertNear(toneAfter, toneBefore, 0.5, '有声部分');
  } finally {
    await ctx.cleanup();
  }
});

test('没有停顿的持续响音不采样噪声，退回默认门限，声音不受影响', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    denoiseOperation,
    { file: [tone] },
    {
      strength: 'light',
    },
  );
  try {
    const data = result.data as DenoiseData;
    assert.equal(data.noiseProfile, 'default');
    assert.equal(data.noiseFloor, -50);
    assert.ok((data.measuredNoise ?? 0) > -35, `measuredNoise ${data.measuredNoise}`);
    assertNear(volumeOf(result.files[0]).mean, volumeOf(tone).mean, 0.3, '音量');
  } finally {
    await ctx.cleanup();
  }
});

test('noiseFloor 手动指定门限，高通 + 低通生效', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    denoiseOperation,
    { file: [noise] },
    {
      strength: 'light',
      reduction: '3',
      noiseFloor: '-60',
      highpass: '200',
      lowpass: '3000',
    },
  );
  try {
    const data = result.data as DenoiseData;
    assert.equal(data.noiseFloor, -60);
    assert.equal(data.reduction, 3);
    assert.equal(data.highpass, 200);
    assert.equal(data.lowpass, 3000);
    const highBefore = bandVolume(noise, 10000);
    const highAfter = bandVolume(result.files[0], 10000);
    assert.ok(
      highAfter < highBefore - 15,
      `10 kHz 处：之前 ${highBefore} dB，之后 ${highAfter} dB`,
    );
  } finally {
    await ctx.cleanup();
  }
});

test(
  'lowpass 不低于奈奎斯特频率时被忽略；没有扩展名的输入按内容沿用 flac',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      denoiseOperation,
      { file: [lowRate] },
      {
        lowpass: 12000,
      },
    );
    try {
      assert.equal(path.extname(result.files[0]), '.flac');
      assert.equal((result.data as DenoiseData).lowpass, null);
      assert.ok(ctx.logs.some((line) => line.includes('已忽略')));
      const info = await probeMedia(result.files[0]);
      assert.equal(info.audio?.sampleRate, 16000);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('视频输入输出纯音频 mp3；没有音轨的视频直接失败', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(denoiseOperation, { file: [video] }, {});
  try {
    assert.equal(path.extname(result.files[0]), '.mp3');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video, undefined);
    assert.equal(info.audio?.codec, 'mp3');
    assertNear(info.duration, 1, 0.1, 'duration');
  } finally {
    await ctx.cleanup();
  }
  await assert.rejects(runOperation(denoiseOperation, { file: [silentVideo] }, {}), /没有音轨/);
});

const NEG = Number.NEGATIVE_INFINITY;

test('parseRmsWindows / quietestSegment 找出最安静、又不是数字静音的一段', () => {
  const lines: string[] = [];
  const levels = [-20, NEG, NEG, -52, -50, -51, -49, -50, -30, -25, -48];
  levels.forEach((rms, i) => {
    lines.push(`frame:${i}    pts:${i * 4410}    pts_time:${(i / 10).toFixed(1)}`);
    lines.push(`lavfi.astats.Overall.RMS_level=${Number.isFinite(rms) ? rms : '-inf'}`);
  });
  const windows = parseRmsWindows(lines.join('\n'));
  assert.equal(windows.length, levels.length);
  assert.equal(windows[1].rms, Number.NEGATIVE_INFINITY);
  const segment = quietestSegment(windows);
  assert.ok(segment);
  assert.equal(segment.start, 0.3);
  assertNear(segment.duration, 0.5, 1e-9, 'duration');
  assertNear(segment.level, -50.3, 0.2, 'level');
  // 全是数字静音时找不到
  assert.equal(quietestSegment(parseRmsWindows(lines.slice(2, 6).join('\n'))), undefined);
  assert.equal(quietestSegment([]), undefined);
});

test('参数校验', () => {
  assert.match(
    paramErrors(denoiseOperation, { strength: 'max' })[0],
    /strength 只能是 light \/ medium \/ strong/,
  );
  assert.match(
    paramErrors(denoiseOperation, { reduction: 100 })[0],
    /reduction 必须是 1 到 97 之间的数字/,
  );
  assert.match(
    paramErrors(denoiseOperation, { noiseFloor: -10 })[0],
    /noiseFloor 必须是 -80 到 -20 之间的数字/,
  );
  assert.match(
    paramErrors(denoiseOperation, { highpass: 5 })[0],
    /highpass 必须是 10 到 2000 之间的数字/,
  );
  assert.match(
    paramErrors(denoiseOperation, { lowpass: 'x' })[0],
    /lowpass 必须是 500 到 48000 之间的数字/,
  );
  assert.deepEqual(paramErrors(denoiseOperation, { highpass: 1000, lowpass: 800 }), [
    'lowpass 必须大于 highpass',
  ]);
  assert.deepEqual(paramErrors(denoiseOperation, { strength: 'Light', highpass: '80' }), []);
});
