import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  planSegments,
  reverseOperation,
  reverseSegmentSeconds,
} from '../../../../src/operations/timeline/reverse';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import { frameLuma, makeRampVideo, meanVolumeDb, near, rampLuma } from './helpers';

let dir = '';
/** 7 秒、亮度每秒 +30，前 2 秒有声音：会被切成 5 秒 + 2 秒两段 */
let ramp = '';
let silent = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-reverse-');
  ramp = makeRampVideo(dir, 'ramp.mp4', { duration: 7, toneUntil: 2 });
  silent = makeVideo(dir, 'silent.mp4', { duration: 2, audio: false });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('分段长度按分辨率控制内存', () => {
  assert.equal(reverseSegmentSeconds(320, 240, 25), 5);
  assert.equal(reverseSegmentSeconds(3840, 2160, 60), 1);
  const hd = reverseSegmentSeconds(1920, 1080, 30);
  assert.ok(hd > 3 && hd <= 5, `1080p30 每段 ${hd} 秒`);
  assert.equal(reverseSegmentSeconds(0, 0, 30), 30);
});

test('planSegments 把零头并进前一段', () => {
  assert.deepEqual(planSegments(7, 5), [
    { start: 0, length: 5 },
    { start: 5, length: 2 },
  ]);
  const segs = planSegments(10.1, 5);
  assert.equal(segs.length, 2);
  assert.ok(near(segs[1].length, 5.1, 1e-9));
  assert.deepEqual(planSegments(3, 5), [{ start: 0, length: 3 }]);
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(reverseOperation, {}), []);
  assert.deepEqual(paramErrors(reverseOperation, { audio: 'backwards' }), [
    'audio 只能是 reverse / original / mute',
  ]);
});

test('分两段倒放后按倒序拼接，声音也倒放', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(reverseOperation, { file: [ramp] });
  try {
    assert.deepEqual(result.data, { duration: 7, segments: 2 });
    const info = await probeMedia(result.files[0]);
    assert.ok(near(info.duration, 7, 0.1), `时长 ${info.duration}`);
    assert.ok(info.video && info.audio);
    // 输出 t 时刻应是原片 7 - t 时刻，亮度约 (7 - t) * 30；跨过 2 秒处的分段边界也要连续递减
    const samples = [0.3, 1.5, 1.9, 2.1, 3.5, 6.5].map((t) => frameLuma(result.files[0], t));
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i] < samples[i - 1], `亮度应递减: ${samples.join(', ')}`);
    }
    assert.ok(near(samples[0], rampLuma(7 - 0.3), 10), `开头亮度 ${samples[0]}`);
    // 原片前 2 秒有声音，倒放后在最后 2 秒
    assert.ok(meanVolumeDb(result.files[0], 0.5, 1) < -60, '开头应该静音');
    assert.ok(meanVolumeDb(result.files[0], 5.5, 1) > -40, '结尾应该有声音');
    const phases = ctx.progressCalls.map((c) => c.extra?.phase).filter(Boolean);
    assert.ok(phases.includes('merging'));
    const fractions = ctx.progressCalls.map((c) => c.fraction);
    assert.deepEqual(
      fractions,
      [...fractions].sort((a, b) => a - b),
      '进度应单调递增',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('audio=original：画面倒放，声音保持原样', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    reverseOperation,
    { file: [ramp] },
    { audio: 'original' },
  );
  try {
    assert.ok(frameLuma(result.files[0], 0.3) > frameLuma(result.files[0], 6));
    assert.ok(meanVolumeDb(result.files[0], 0.5, 1) > -40, '开头应该有声音');
    assert.ok(meanVolumeDb(result.files[0], 5.5, 1) < -60, '结尾应该静音');
  } finally {
    await ctx.cleanup();
  }
});

test('audio=mute 去掉声音；没有音轨的视频也能倒放', { skip: ffmpegSkip }, async () => {
  const muted = await runOperation(reverseOperation, { file: [ramp] }, { audio: 'mute' });
  try {
    const info = await probeMedia(muted.result.files[0]);
    assert.equal(info.audio, undefined);
  } finally {
    await muted.ctx.cleanup();
  }
  const noAudio = await runOperation(reverseOperation, { file: [silent] });
  try {
    const info = await probeMedia(noAudio.result.files[0]);
    assert.ok(info.video);
    assert.equal(info.audio, undefined);
    assert.ok(near(info.duration, 2, 0.1));
  } finally {
    await noAudio.ctx.cleanup();
  }
});

test('纯音频倒放输出 m4a；audio=original 对纯音频报错', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'pad.wav', { duration: 1, silencePad: 0.5 });
  const { result, ctx } = await runOperation(reverseOperation, { file: [audio] });
  try {
    assert.ok(result.files[0].endsWith('.m4a'));
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video, undefined);
    assert.ok(near(info.duration, 2, 0.1), `时长 ${info.duration}`);
  } finally {
    await ctx.cleanup();
  }
  await assert.rejects(
    runOperation(reverseOperation, { file: [audio] }, { audio: 'original' }),
    /纯音频文件只能 audio=reverse/,
  );
});

test('超过 10 分钟的素材直接拒绝', { skip: ffmpegSkip }, async () => {
  const long = makeAudio(dir, 'long.wav', { duration: 601, sampleRate: 8000, channels: 1 });
  await assert.rejects(
    runOperation(reverseOperation, { file: [long] }),
    /时长 601 秒超过倒放上限 10 分钟/,
  );
});

test('取消任务会杀掉正在运行的 ffmpeg', { skip: ffmpegSkip }, async () => {
  const controller = new AbortController();
  const ctx = createTestContext({ file: [ramp] }, { signal: controller.signal });
  try {
    const params = reverseOperation.params.parse({});
    const running = reverseOperation.run(ctx, params);
    // 第一次 ffmpeg 开始后取消
    const timer = setInterval(() => {
      if (ctx.progressCalls.length > 0) controller.abort(new Error('任务已取消'));
    }, 5);
    await assert.rejects(running, /任务已取消/);
    clearInterval(timer);
  } finally {
    await ctx.cleanup();
  }
});
