import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mixAudioOperation, mixGraph } from '../../../../src/operations/audio/mix';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { assertNear, bandVolume, makePipedWebm, volumeOf } from './audio-helpers';

interface MixData {
  inputs: number;
  duration: number;
  sampleRate: number;
  channels: number;
}

let dir = '';
let voice = '';
let bgm = '';
let loudA = '';
let loudB = '';
let video = '';
let silentVideo = '';
let noDuration = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-audio-mix-');
  voice = makeAudio(dir, 'voice.wav', { duration: 1, freq: 440, channels: 1 });
  bgm = makeAudio(dir, 'bgm.mp3', { duration: 2, freq: 1000, sampleRate: 48000 });
  // 两路满幅正弦相加会削波
  loudA = makeAudio(dir, 'loud-a.wav', { duration: 1, freq: 440, volume: 7 });
  loudB = makeAudio(dir, 'loud-b.wav', { duration: 1, freq: 440, volume: 7 });
  video = makeVideo(dir, 'clip.mp4', { duration: 1 });
  silentVideo = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
  // 管道写出的 webm 没有时长信息（浏览器 MediaRecorder 录音常见）
  noDuration = makePipedWebm(dir, 'nodur.weba', [
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:duration=3',
    '-c:a',
    'libopus',
  ]);
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test(
  '人声 + 背景音乐：两路都在，背景按 volumes 降低，默认取最长',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      mixAudioOperation,
      { files: [voice, bgm] },
      {
        volumes: '1,0.25',
      },
    );
    try {
      assert.equal(path.extname(result.files[0]), '.wav');
      const data = result.data as MixData;
      assert.equal(data.sampleRate, 48000);
      assert.equal(data.channels, 2);
      assertNear(data.duration, 2, 0.05, 'data.duration');
      const info = await probeMedia(result.files[0]);
      assertNear(info.duration, 2, 0.1, 'duration');
      const first = { start: 0.2, duration: 0.6 };
      const at440 = bandVolume(result.files[0], 440, first);
      const at1000 = bandVolume(result.files[0], 1000, first);
      // 不做 amix 默认的平均衰减：人声保持原音量，背景音乐按 0.25 倍降低约 12 dB
      assertNear(at440, bandVolume(voice, 440, first), 1, '人声音量');
      assertNear(at1000, bandVolume(bgm, 1000, first) - 12, 1, '背景音量');
    } finally {
      await ctx.cleanup();
    }
  },
);

test('duration=shortest / first 和 delays', { skip: ffmpegSkip }, async () => {
  const shortest = await runOperation(
    mixAudioOperation,
    { files: [bgm, voice] },
    {
      duration: 'shortest',
    },
  );
  try {
    assertNear((await probeMedia(shortest.result.files[0])).duration, 1, 0.1, 'shortest');
  } finally {
    await shortest.ctx.cleanup();
  }
  // 人声延迟 1.5 秒开始：最长一轨变成 2.5 秒；first 以第一轨（人声，含延迟）为准
  const delayed = await runOperation(
    mixAudioOperation,
    { files: [voice, bgm] },
    {
      delays: [1.5, 0],
      duration: 'first',
      format: 'm4a',
    },
  );
  try {
    assert.equal(path.extname(delayed.result.files[0]), '.m4a');
    assertNear((delayed.result.data as MixData).duration, 2.5, 0.05, 'data.duration');
    const info = await probeMedia(delayed.result.files[0]);
    assertNear(info.duration, 2.5, 0.1, 'first + delay');
    // 前 1.5 秒只有背景音乐
    const head = { start: 0.3, duration: 0.8 };
    const out = delayed.result.files[0];
    assert.ok(bandVolume(out, 440, head) < bandVolume(out, 1000, head) - 20);
  } finally {
    await delayed.ctx.cleanup();
  }
});

test('默认限幅器防止叠加削波；关掉后会削到 0 dBFS', { skip: ffmpegSkip }, async () => {
  const limited = await runOperation(mixAudioOperation, { files: [loudA, loudB] }, {});
  try {
    const { max } = volumeOf(limited.result.files[0]);
    assert.ok(max <= -0.1, `峰值 ${max} dB`);
  } finally {
    await limited.ctx.cleanup();
  }
  const raw = await runOperation(mixAudioOperation, { files: [loudA, loudB] }, { limiter: false });
  try {
    assert.equal(volumeOf(raw.result.files[0]).max, 0);
  } finally {
    await raw.ctx.cleanup();
  }
});

test('视频可以作为输入；没有音轨的文件给出是第几个', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(mixAudioOperation, { files: [video, voice] }, {});
  try {
    // 第 1 个是视频，不是可输出的音频格式，退回 mp3
    assert.equal(path.extname(result.files[0]), '.mp3');
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video, undefined);
  } finally {
    await ctx.cleanup();
  }
  await assert.rejects(
    runOperation(mixAudioOperation, { files: [voice, silentVideo] }, {}),
    /第 2 个文件没有音轨/,
  );
});

test('有输入拿不到时长时，data.duration 是实际输出的长度', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    mixAudioOperation,
    { files: [voice, noDuration] },
    { delays: '0,0.5', format: 'wav' },
  );
  try {
    const data = result.data as MixData;
    // 最长的一轨是延迟 0.5 秒的 3 秒 webm；按探测时长算会得到 max(1, 0 + 0.5) = 1
    assertNear(data.duration, 3.5, 0.1, 'data.duration');
    const info = await probeMedia(result.files[0]);
    assertNear(info.duration, 3.5, 0.1, 'duration');
  } finally {
    await ctx.cleanup();
  }
});

test('mixGraph：关闭 amix 归一化，音量和延迟只含数字', () => {
  const graph = mixGraph(
    { sampleRate: 48000, channels: 2 },
    [1, 2],
    [1, 0.3],
    [0, 2.5],
    'longest',
    true,
  );
  assert.ok(graph.startsWith('[0:a:0]pan=stereo|c0=c0|c1=c0,aresample=48000'));
  assert.ok(graph.includes('[1:a:0]aresample=48000'));
  assert.ok(graph.includes(',volume=0.3,adelay=delays=2500:all=1[m1]'));
  assert.ok(!graph.includes('[m0]volume'));
  assert.ok(
    graph.endsWith(
      '[m0][m1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,' +
        'alimiter=limit=0.97:level=0:latency=1[out]',
    ),
  );
});

test('参数校验', () => {
  const two = { files: 2 };
  assert.deepEqual(paramErrors(mixAudioOperation, { volumes: '1,0.5,0.2' }, two), [
    'volumes 需要 2 个值（每个文件一个），实际收到 3 个',
  ]);
  assert.deepEqual(paramErrors(mixAudioOperation, { delays: [1] }, two), [
    'delays 需要 2 个值（每个文件一个），实际收到 1 个',
  ]);
  assert.match(
    paramErrors(mixAudioOperation, { volumes: '1,abc' }, two)[0],
    /volumes 必须是逗号分隔的数字列表（如 1,0.5），每项 0 到 10 倍/,
  );
  assert.match(
    paramErrors(mixAudioOperation, { delays: '0,4000' }, two)[0],
    /delays 必须是逗号分隔的数字列表/,
  );
  assert.match(
    paramErrors(mixAudioOperation, { duration: 'all' }, two)[0],
    /duration 只能是 longest \/ shortest \/ first/,
  );
  assert.deepEqual(
    paramErrors(mixAudioOperation, { volumes: [1, '0.5'], delays: '0, 1.5' }, two),
    [],
  );
  assert.deepEqual(mixAudioOperation.inputs[0].multiple, { min: 2, max: 8 });
});
