import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import { normalizeRawParams } from '../../../../src/core/params';
import { compress } from '../../../../src/operations/effects/compress';
import { probeMedia } from '../../../../src/utils/media-probe';
import { streamInfo } from './fixtures';

const MB = 1024 * 1024;

let dir = '';
let video = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-compress-');
  // 高码率编码的原片，压缩才有空间
  const raw = makeVideo(dir, 'raw.mp4', { size: '320x240', duration: 3 });
  video = path.join(dir, 'in.mp4');
  generate([
    '-i',
    raw,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '12',
    '-c:a',
    'copy',
    video,
  ]);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface CompressData {
  originalSize: number;
  outputSize: number;
  ratio: number;
  mode: string;
  targetSize?: number;
  withinTarget?: boolean;
  attempts?: number;
  width: number;
  height: number;
  audioBitrate: number;
}

test('compress：targetSizeMB 两遍编码，输出不超过目标的 110%', { skip: ffmpegSkip }, async () => {
  const target = 0.1;
  const { result, ctx } = await runOperation(compress, { file: [video] }, { targetSizeMB: target });
  try {
    const out = result.files[0];
    const size = fs.statSync(out).size;
    assert.ok(size <= target * MB * 1.1, `输出 ${size} 字节，目标 ${target * MB}`);
    assert.ok(size >= target * MB * 0.6, `输出 ${size} 字节，远小于目标，码率计算可能有误`);
    const data = result.data as CompressData;
    assert.equal(data.mode, 'targetSize');
    assert.equal(data.outputSize, size);
    assert.equal(data.originalSize, fs.statSync(video).size);
    assert.equal(data.ratio, Math.round((size / data.originalSize) * 10000) / 10000);
    const info = await probeMedia(out);
    assert.equal(info.video?.codec, 'h264');
    assert.equal(info.audio?.codec, 'aac');
    assert.ok(Math.abs(info.duration - 3) < 0.15);
    // 第一遍 analyzing、第二遍 processing，进度单调递增到 1
    const phases = ctx.progressCalls.filter((c) => c.extra?.phase).map((c) => c.extra?.phase);
    assert.deepEqual(phases, ['analyzing', 'processing']);
    const fractions = ctx.progressCalls.map((c) => c.fraction);
    for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1]);
    assert.equal(fractions.at(-1), 1);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'compress：h265 按目标大小（短片首帧容易超标，会自动重编）',
  { skip: ffmpegSkip },
  async () => {
    const target = 0.06;
    const { result, ctx } = await runOperation(
      compress,
      { file: [video] },
      { targetSizeMB: target, codec: 'h265', audioBitrate: '48k', speed: 'fast' },
    );
    try {
      const out = result.files[0];
      const size = fs.statSync(out).size;
      assert.ok(size <= target * MB * 1.1, `输出 ${size} 字节，目标 ${target * MB}`);
      const info = await streamInfo(out);
      assert.equal(info.videoCodec, 'hevc');
      // 苹果设备只认 hvc1 标签
      assert.equal(info.videoTag, 'hvc1');
      assert.equal((result.data as CompressData).audioBitrate, 48000);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('compress：vp9 / av1 按目标大小也不超过 110%', { skip: ffmpegSkip }, async () => {
  const target = 0.08;
  // vp9 → webm + Opus：Opus 默认 VBR 在正弦波上会超码率，按大小压缩时必须用受限 VBR
  for (const codec of ['vp9', 'av1']) {
    const { result, ctx } = await runOperation(
      compress,
      { file: [video] },
      { targetSizeMB: target, codec, speed: 'fast' },
    );
    try {
      const size = fs.statSync(result.files[0]).size;
      assert.ok(size <= target * MB * 1.1, `${codec}: 输出 ${size} 字节，目标 ${target * MB}`);
      const info = await streamInfo(result.files[0]);
      assert.equal(info.videoCodec, codec);
      assert.deepEqual(info.audioCodecs, [codec === 'vp9' ? 'opus' : 'aac']);
    } finally {
      await ctx.cleanup();
    }
  }
});

/**
 * 直接调用 compress.run，记录每条 ffmpeg 命令；每次第二遍编码结束后调用 afterPass2，
 * 用来往产物里补字节，模拟编码器超出码率（x264 在短片、噪点多的素材上常见）
 */
async function runWithPass2Hook(
  file: string,
  raw: Record<string, unknown>,
  afterPass2: (index: number, output: string) => Promise<void>,
) {
  const parsed = compress.params.parse(normalizeRawParams(raw));
  const ctx = createTestContext({ file: [file] });
  const calls: string[][] = [];
  const realFfmpeg = ctx.ffmpeg.bind(ctx);
  let pass2Count = 0;
  ctx.ffmpeg = async (args, opts) => {
    const res = await realFfmpeg(args, opts);
    calls.push(args);
    const i = args.indexOf('-pass');
    if (i >= 0 && args[i + 1] === '2') await afterPass2(pass2Count++, args[args.length - 1]);
    return res;
  };
  try {
    const result = await compress.run(ctx, parsed);
    return { result, ctx, calls };
  } catch (err) {
    await ctx.cleanup();
    throw err;
  }
}

const passOf = (args: string[]) => args[args.indexOf('-pass') + 1];
const bitrateOf = (args: string[]) => args[args.indexOf('-b:v') + 1];

test('compress：超出目标重编时连第一遍一起重跑，写到新文件', { skip: ffmpegSkip }, async () => {
  const target = 0.1;
  // 第一次的产物补 60% 目标大小的字节，必然超出预算；重编不补
  const { result, ctx, calls } = await runWithPass2Hook(
    video,
    { targetSizeMB: target },
    async (i, out) => {
      if (i === 0) await fs.promises.appendFile(out, Buffer.alloc(Math.round(target * MB * 0.6)));
    },
  );
  try {
    const data = result.data as CompressData & { videoBitrate: number };
    // 统计和第一遍的码率有关：重编必须用新码率重新跑第一遍，不能复用旧统计
    assert.deepEqual(calls.map(passOf), ['1', '2', '1', '2']);
    assert.equal(bitrateOf(calls[0]), bitrateOf(calls[1]));
    assert.equal(bitrateOf(calls[2]), String(data.videoBitrate));
    assert.equal(bitrateOf(calls[3]), String(data.videoBitrate));
    assert.ok(Number(bitrateOf(calls[2])) < Number(bitrateOf(calls[0])));
    // 重编写到新文件，第一次的产物删掉，输出目录只剩一个文件
    const first = calls[1].at(-1) ?? '';
    assert.notEqual(result.files[0], first);
    assert.equal(fs.existsSync(first), false);
    assert.equal(result.files[0], calls[3].at(-1));
    assert.equal(fs.readdirSync(ctx.outputRoot).length, 1);
    assert.equal(data.attempts, 2);
    assert.equal(data.withinTarget, true);
    assert.equal(data.outputSize, fs.statSync(result.files[0]).size);
    assert.ok(ctx.logs.some((l) => l.includes('超出预算')));
    const fractions = ctx.progressCalls.map((c) => c.fraction);
    for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1]);
    assert.equal(fractions.at(-1), 1);
  } finally {
    await ctx.cleanup();
  }
});

test('compress：重编结果反而更大时保留第一次的结果', { skip: ffmpegSkip }, async () => {
  const target = 0.1;
  const { result, ctx, calls } = await runWithPass2Hook(
    video,
    { targetSizeMB: target },
    async (i, out) => {
      const extra = i === 0 ? target * MB * 0.6 : target * MB * 3;
      await fs.promises.appendFile(out, Buffer.alloc(Math.round(extra)));
    },
  );
  try {
    const data = result.data as CompressData & { videoBitrate: number };
    assert.equal(calls.length, 4);
    const first = calls[1].at(-1) ?? '';
    assert.equal(result.files[0], first);
    assert.equal(fs.existsSync(calls[3].at(-1) ?? ''), false, '更大的重编结果应删除');
    assert.equal(fs.readdirSync(ctx.outputRoot).length, 1);
    assert.equal(String(data.videoBitrate), bitrateOf(calls[1]));
    assert.equal(data.outputSize, fs.statSync(first).size);
    assert.equal(data.attempts, 2);
    assert.equal(data.withinTarget, false);
    assert.ok(ctx.logs.some((l) => l.includes('保留第一次的结果')));
  } finally {
    await ctx.cleanup();
  }
});

test('compress：噪点多的短片 x264 超出目标，重编后落在目标内', { skip: ffmpegSkip }, async () => {
  // 这类素材 x264 第二遍会明显超出码率；复用旧的第一遍统计重编，结果甚至比第一次还大
  const noisy = path.join(dir, 'noisy.mp4');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=2,noise=alls=20:allf=t+u',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    noisy,
  ]);
  const target = 0.4;
  const { result, ctx } = await runOperation(compress, { file: [noisy] }, { targetSizeMB: target });
  try {
    const data = result.data as CompressData;
    const size = fs.statSync(result.files[0]).size;
    assert.equal(data.outputSize, size);
    assert.equal(data.withinTarget, true, `输出 ${size} 字节，目标 ${target * MB}`);
    const overshoot = ctx.logs.map((l) => /输出 (\d+) 字节超出预算/.exec(l)).find(Boolean);
    if (overshoot) assert.ok(size < Number(overshoot[1]), '重编结果不应比第一次大');
    assert.equal(fs.readdirSync(ctx.outputRoot).length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('compress：quality 档位 + 限制分辨率 + 限制帧率', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    compress,
    { file: [video] },
    { quality: 'low', maxWidth: 160, maxFps: 15 },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 160);
    assert.equal(info.video?.height, 120);
    assert.equal(info.video?.frameRate, '15/1');
    const data = result.data as CompressData;
    assert.equal(data.mode, 'quality');
    assert.ok(data.ratio < 0.5, `ratio ${data.ratio}`);
    assert.deepEqual([data.width, data.height], [160, 120]);
  } finally {
    await ctx.cleanup();
  }
});

test('compress：vp9 默认输出 webm + Opus，av1 输出 mp4', { skip: ffmpegSkip }, async () => {
  const short = path.join(dir, 'short.mp4');
  generate(['-i', video, '-t', '1', '-c', 'copy', short]);
  const vp9 = await runOperation(compress, { file: [short] }, { codec: 'vp9', speed: 'fast' });
  try {
    assert.match(vp9.result.files[0], /\.webm$/);
    const info = await streamInfo(vp9.result.files[0]);
    assert.equal(info.videoCodec, 'vp9');
    assert.deepEqual(info.audioCodecs, ['opus']);
  } finally {
    await vp9.ctx.cleanup();
  }
  const av1 = await runOperation(
    compress,
    { file: [short] },
    { codec: 'av1', speed: 'fast', removeAudio: true },
  );
  try {
    assert.match(av1.result.files[0], /\.mp4$/);
    const info = await streamInfo(av1.result.files[0]);
    assert.equal(info.videoCodec, 'av1');
    assert.deepEqual(info.audioCodecs, []);
  } finally {
    await av1.ctx.cleanup();
  }
});

test('compress：目标大于原文件时不会把文件变大', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(compress, { file: [video] }, { targetSizeMB: 50 });
  try {
    const data = result.data as CompressData;
    assert.ok(data.outputSize <= data.originalSize, JSON.stringify(data));
    assert.ok(ctx.logs.some((l) => l.includes('目标大小超过原文件')));
  } finally {
    await ctx.cleanup();
  }
});

test('compress：目标太小、纯音频输入返回明确错误', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(compress, { file: [video] }, { targetSizeMB: 0.01 }),
    /目标大小 0\.01 MB 太小.*请调大 targetSizeMB/,
  );
  const audio = makeAudio(dir, 'a.m4a', { duration: 1 });
  await assert.rejects(
    runOperation(compress, { file: [audio] }, { quality: 'low' }),
    /输入文件不包含视频画面/,
  );
});

test('compress：参数校验', () => {
  assert.deepEqual(paramErrors(compress, { targetSizeMB: 10, quality: 'low' }), [
    'targetSizeMB 和 quality 只能二选一：按目标大小压缩时码率由大小决定',
  ]);
  assert.deepEqual(paramErrors(compress, { codec: 'h264', format: 'webm' }), [
    'webm 只支持 vp9 和 av1 编码，h264 / h265 请用 mp4',
  ]);
  assert.deepEqual(paramErrors(compress, { audioBitrate: '8k' }), [
    'audioBitrate 必须在 16k 到 512k 之间',
  ]);
  assert.deepEqual(paramErrors(compress, { audioBitrate: 'loud' }), [
    'audioBitrate 必须是码率，如 128k、2M 或 800000',
  ]);
  assert.deepEqual(paramErrors(compress, { maxWidth: 10 }), [
    'maxWidth 必须是 64 到 7680 之间的整数',
  ]);
  assert.deepEqual(paramErrors(compress, { targetSizeMB: 0 }), [
    'targetSizeMB 必须是 0.01 到 100000 之间的数字',
  ]);
  assert.deepEqual(paramErrors(compress, { codec: 'mpeg2' }), [
    'codec 只能是 h264 / h265 / vp9 / av1',
  ]);
  assert.deepEqual(paramErrors(compress, {}), []);
  assert.deepEqual(paramErrors(compress, { codec: 'AV1', format: 'webm', audioBitrate: 96 }), []);
});
