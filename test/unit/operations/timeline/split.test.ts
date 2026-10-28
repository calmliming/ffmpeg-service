import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import {
  parseSegmentList,
  planSplit,
  splitOperation,
} from '../../../../src/operations/timeline/split';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { frameLuma, makeRampVideo, near, rampLuma } from './helpers';

interface PartData {
  index: number;
  start: number;
  end: number;
  duration: number;
  file: string;
}

let dir = '';
/** 6 秒，亮度每秒 +30，关键帧间隔 1 秒（-g 25） */
let ramp = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-split-');
  ramp = makeRampVideo(dir, 'ramp.mp4', { duration: 6, toneUntil: 6 });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('planSplit 三种分段方式', () => {
  assert.deepEqual(planSplit({ segmentDuration: 4 }, 10), [
    { start: 0, end: 4 },
    { start: 4, end: 8 },
    { start: 8, end: 10 },
  ]);
  // 最后的零头不足 0.1 秒，并进最后一段
  assert.deepEqual(planSplit({ segmentDuration: 5 }, 10.05), [
    { start: 0, end: 5 },
    { start: 5, end: 10.05 },
  ]);
  assert.deepEqual(planSplit({ timestamps: [7, 2, 2, 0] }, 10), [
    { start: 0, end: 2 },
    { start: 2, end: 7 },
    { start: 7, end: 10 },
  ]);
  assert.deepEqual(planSplit({ parts: 4 }, 10), [
    { start: 0, end: 2.5 },
    { start: 2.5, end: 5 },
    { start: 5, end: 7.5 },
    { start: 7.5, end: 10 },
  ]);
  assert.throws(() => planSplit({ timestamps: [3, 12] }, 10), /分割点 12 秒超出了时长 10 秒/);
  assert.throws(
    () => planSplit({ segmentDuration: 0.5 }, 100),
    /按每段 0.5 秒分割会得到 200 段，超过上限 100 段/,
  );
});

test('参数校验', () => {
  const only = 'segmentDuration、timestamps、parts 必须且只能提供一个';
  assert.deepEqual(paramErrors(splitOperation, {}), [only]);
  assert.deepEqual(paramErrors(splitOperation, { parts: 2, segmentDuration: 3 }), [only]);
  assert.deepEqual(paramErrors(splitOperation, { parts: 101 }), [
    'parts 必须是 2 到 100 之间的整数',
  ]);
  assert.deepEqual(paramErrors(splitOperation, { segmentDuration: 0.2 }), [
    'segmentDuration 至少 0.5 秒',
  ]);
  assert.deepEqual(paramErrors(splitOperation, { timestamps: '1,abc' }), [
    'timestamps 第 2 个时间格式不对，应为秒数或 HH:MM:SS',
  ]);
  assert.deepEqual(paramErrors(splitOperation, { timestamps: '1,00:00:02', mode: 'fast' }), []);
  assert.deepEqual(paramErrors(splitOperation, { parts: 2, mode: 'slow' }), [
    'mode 只能是 accurate / fast',
  ]);
});

test('accurate：按时间点逐帧精确切开', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    splitOperation,
    { file: [ramp] },
    { timestamps: '1.5,00:00:04' },
  );
  try {
    assert.equal(result.files.length, 3);
    assert.equal(result.primary, result.files[0]);
    const data = result.data as { count: number; parts: PartData[] };
    assert.equal(data.count, 3);
    assert.deepEqual(
      data.parts.map((p) => [p.index, p.start, p.end, p.file]),
      [
        [1, 0, 1.5, 'part_001.mp4'],
        [2, 1.5, 4, 'part_002.mp4'],
        [3, 4, 6, 'part_003.mp4'],
      ],
    );
    // 所有产物在同一个目录
    assert.equal(new Set(result.files.map((f) => path.dirname(f))).size, 1);
    const expected = [1.5, 2.5, 2];
    for (let i = 0; i < 3; i++) {
      const info = await probeMedia(result.files[i]);
      assert.ok(near(info.duration, expected[i], 0.08), `第 ${i + 1} 段时长 ${info.duration}`);
      assert.ok(info.video && info.audio);
    }
    // 第 2 段的第一帧就是原片 1.5 秒
    const luma = frameLuma(result.files[1], 0);
    assert.ok(near(luma, rampLuma(1.5), 6), `第 2 段开头亮度 ${luma}`);
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

test('fast：在关键帧处流复制切开，data 给出实际切点', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    splitOperation,
    { file: [ramp] },
    { timestamps: '1.5,4', mode: 'fast' },
  );
  try {
    const data = result.data as { parts: PartData[] };
    assert.equal(result.files.length, 3);
    // 关键帧每 1 秒一个：1.5 秒的切点推后到 2 秒
    assert.ok(near(data.parts[0].end, 2, 0.05), `第 1 段结束 ${data.parts[0].end}`);
    assert.ok(near(data.parts[1].end, 4, 0.05), `第 2 段结束 ${data.parts[1].end}`);
    assert.ok(near(data.parts[2].end, 6, 0.1), `第 3 段结束 ${data.parts[2].end}`);
    const info = await probeMedia(result.files[1]);
    assert.equal(info.video?.codec, 'h264');
    assert.ok(result.files.every((f) => f.endsWith('.mp4')));
  } finally {
    await ctx.cleanup();
  }
});

test('parseSegmentList：读出每段文件的起止时间', () => {
  const csv = 'part_001.mkv,0.000000,1.001000\r\n"part,002.mkv",1.001000,2.002000\n\nbad line\n';
  assert.deepEqual(
    [...parseSegmentList(csv)],
    [
      ['part_001.mkv', { start: 0, end: 1.001 }],
      ['part,002.mkv', { start: 1.001, end: 2.002 }],
    ],
  );
});

test(
  'fast：带 B 帧的 MKV（流上没有时长）data.parts 给出真实切点，误差不累积',
  { skip: ffmpegSkip },
  async () => {
    // 29.97 fps、每 30 帧一个关键帧（1.001 秒），H.264 带 B 帧 + Opus，只能放进 MKV。
    // MKV 的文件时长含 B 帧带来的起始偏移（约 0.07 秒），按文件时长累加会越加越偏
    const mkv = path.join(dir, 'bframes.mkv');
    generate([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30000/1001:duration=4.2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4.2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-bf',
      '3',
      '-g',
      '30',
      '-keyint_min',
      '30',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      mkv,
    ]);
    const { result, ctx } = await runOperation(
      splitOperation,
      { file: [mkv] },
      { segmentDuration: 1, mode: 'fast' },
    );
    try {
      const parts = (result.data as { parts: PartData[] }).parts;
      assert.ok(result.files.every((f) => f.endsWith('.mkv')));
      assert.equal(parts.length, 5);
      const gop = 30 * (1001 / 30000);
      parts.forEach((part, i) => {
        assert.ok(near(part.start, i * gop, 0.002), `第 ${i + 1} 段开始 ${part.start}`);
        if (i > 0) assert.equal(part.start, parts[i - 1].end);
      });
      for (let i = 0; i < 4; i++) {
        assert.ok(near(parts[i].end, (i + 1) * gop, 0.002), `第 ${i + 1} 段结束 ${parts[i].end}`);
      }
      // 126 帧，最后一段结束在画面结尾，不会超出原片
      const last = parts[parts.length - 1];
      assert.ok(near(last.end, 126 * (1001 / 30000), 0.003), `最后一段结束 ${last.end}`);
      // 每段产物完整：前 4 段各 30 帧，最后 6 帧
      const frames = result.files.map((file) =>
        Number(
          execFileSync(
            config.ffprobePath,
            [
              '-v',
              'error',
              '-count_frames',
              '-select_streams',
              'v:0',
              '-show_entries',
              'stream=nb_read_frames',
              '-of',
              'csv=p=0',
              file,
            ],
            { encoding: 'utf8' },
          ).trim(),
        ),
      );
      assert.deepEqual(frames, [30, 30, 30, 30, 6]);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('parts 平均分段；没有音轨的视频', { skip: ffmpegSkip }, async () => {
  const silent = makeVideo(dir, 'silent.mp4', { duration: 3, audio: false });
  const { result, ctx } = await runOperation(splitOperation, { file: [silent] }, { parts: 3 });
  try {
    assert.equal(result.files.length, 3);
    for (const file of result.files) {
      const info = await probeMedia(file);
      assert.ok(near(info.duration, 1, 0.08), `时长 ${info.duration}`);
      assert.equal(info.audio, undefined);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('纯音频：accurate 输出 m4a，fast 保持 mp3', { skip: ffmpegSkip }, async () => {
  const mp3 = makeAudio(dir, 'a.mp3', { duration: 3 });
  const accurate = await runOperation(splitOperation, { file: [mp3] }, { segmentDuration: 1 });
  try {
    assert.equal(accurate.result.files.length, 3);
    assert.ok(accurate.result.files.every((f) => f.endsWith('.m4a')));
  } finally {
    await accurate.ctx.cleanup();
  }
  const fast = await runOperation(
    splitOperation,
    { file: [mp3] },
    { segmentDuration: 1, mode: 'fast' },
  );
  try {
    assert.equal(fast.result.files.length, 3);
    assert.ok(fast.result.files.every((f) => f.endsWith('.mp3')));
    const info = await probeMedia(fast.result.files[1]);
    assert.ok(near(info.duration, 1, 0.1), `时长 ${info.duration}`);
  } finally {
    await fast.ctx.cleanup();
  }
});

test('分割点超出时长、段数超过上限', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(splitOperation, { file: [ramp] }, { timestamps: '2,7' }),
    /分割点 7 秒超出了时长 6 秒/,
  );
  const long = makeAudio(dir, 'long.wav', { duration: 51, sampleRate: 8000, channels: 1 });
  await assert.rejects(
    runOperation(splitOperation, { file: [long] }, { segmentDuration: 0.5 }),
    /按每段 0.5 秒分割会得到 102 段，超过上限 100 段/,
  );
});
