import fs from 'fs';
import { z } from 'zod';
import { booleanParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation, type OperationContext } from '../types';
import { fileInput, probeInput, round } from './shared';

/** 解码占总进度的比例，剩下的是 Node 里逐块统计 */
const DECODE_SHARE = 0.85;
/** split 模式最多保留的声道数，再多的环绕声文件只能用 mono */
const MAX_SPLIT_CHANNELS = 8;
/** 中间 PCM 文件的目标采样率：画波形看的是包络，8 kHz 足够 */
const BASE_RATE = 8000;
const MIN_RATE = 2000;
const MAX_RATE = 48000;
/** 中间 PCM 文件的大小目标（字节），超长音频降低采样率；最低采样率下仍超出时按实际时长占用 */
const MAX_PCM_BYTES = 200 * 1024 * 1024;
/** 每个点至少要有几个采样，短音频提高采样率 */
const MIN_SAMPLES_PER_POINT = 4;

const params = z.object({
  points: numberParam('points', { min: 100, max: 20000, int: true })
    .default(1000)
    .meta({ description: '波形点数（100-20000），通常取播放器宽度的像素数，默认 1000' }),
  channels: enumParam('channels', ['mono', 'split'] as const)
    .default('mono')
    .meta({
      description:
        'mono：所有声道合成一条波形（每个点取全部声道的最小 / 最大值），默认；split：每个声道一条',
    }),
  normalize: booleanParam('normalize')
    .default(false)
    .meta({ description: '是否把最大峰值放大到 ±1，让很轻的音频也能画出饱满的波形，默认 false' }),
  output: enumParam('output', ['data', 'file'] as const)
    .default('data')
    .meta({
      description:
        'data：峰值放在任务结果里，默认；file：峰值写成 JSON 文件作为产物（点数多时推荐，任务结果里只保留元信息）',
    }),
});

/** 选中间 PCM 的采样率：默认 8 kHz，超长音频降低以控制磁盘占用，极短音频提高以保证每个点都有采样 */
export function pickSampleRate(duration: number, points: number, channels: number): number {
  if (!(duration > 0)) return BASE_RATE;
  const maxFrames = MAX_PCM_BYTES / (2 * Math.max(1, channels));
  let rate = BASE_RATE;
  if (duration * rate > maxFrames) rate = Math.max(MIN_RATE, Math.floor(maxFrames / duration));
  if (duration * rate < points * MIN_SAMPLES_PER_POINT) {
    rate = Math.min(MAX_RATE, Math.ceil((points * MIN_SAMPLES_PER_POINT) / duration));
  }
  return rate;
}

export interface PeakStats {
  /** 实际的点数（采样数少于请求的点数时会变少） */
  points: number;
  frames: number;
  /** 每个声道每个点的最小 / 最大采样值（int16），按 [声道][点] 排列 */
  min: Int16Array[];
  max: Int16Array[];
}

/**
 * 流式读取交错的 s16le PCM，按点统计最小 / 最大值，内存只和点数有关。
 * 第 f 个采样落在第 floor(f * points / frames) 个点
 */
export async function computePeaks(
  file: string,
  channels: number,
  requestedPoints: number,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<PeakStats> {
  const frameBytes = 2 * channels;
  const size = (await fs.promises.stat(file)).size;
  const frames = Math.floor(size / frameBytes);
  if (frames === 0) throw new Error('音轨解码后没有任何采样，无法生成波形');
  const points = Math.min(requestedPoints, frames);
  const min = Array.from({ length: channels }, () => new Int16Array(points).fill(32767));
  const max = Array.from({ length: channels }, () => new Int16Array(points).fill(-32768));

  let frame = 0;
  let point = 0;
  let nextStart = Math.ceil(frames / points);
  let carry: Buffer = Buffer.alloc(0);
  let read = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    if (signal?.aborted) throw signal.reason;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    const usable = buf.length - (buf.length % frameBytes);
    for (let offset = 0; offset < usable && frame < frames; offset += frameBytes, frame++) {
      while (frame >= nextStart && point < points - 1) {
        point++;
        nextStart = Math.ceil(((point + 1) * frames) / points);
      }
      for (let c = 0; c < channels; c++) {
        const v = buf.readInt16LE(offset + 2 * c);
        if (v < min[c][point]) min[c][point] = v;
        if (v > max[c][point]) max[c][point] = v;
      }
    }
    carry = buf.subarray(usable);
    read += (chunk as Buffer).length;
    onProgress?.(read / size);
  }
  return { points, frames, min, max };
}

/** 统计结果 → [[min, max], …]，归一化到 -1..1 并保留 4 位小数 */
export function toPeakPairs(
  stats: PeakStats,
  mode: 'mono' | 'split',
  normalize: boolean,
): number[][] | number[][][] {
  let scale = 32768;
  if (normalize) {
    let peak = 0;
    for (let c = 0; c < stats.min.length; c++) {
      for (let i = 0; i < stats.points; i++) {
        peak = Math.max(peak, Math.abs(stats.min[c][i]), Math.abs(stats.max[c][i]));
      }
    }
    if (peak > 0) scale = peak;
  }
  const value = (v: number) => round(Math.max(-1, Math.min(1, v / scale)), 4);
  const channelPairs = (c: number) =>
    Array.from({ length: stats.points }, (_, i) => [
      value(stats.min[c][i]),
      value(stats.max[c][i]),
    ]);
  if (mode === 'split') return stats.min.map((_, c) => channelPairs(c));
  return Array.from({ length: stats.points }, (_, i) => {
    let lo = 32767;
    let hi = -32768;
    for (let c = 0; c < stats.min.length; c++) {
      lo = Math.min(lo, stats.min[c][i]);
      hi = Math.max(hi, stats.max[c][i]);
    }
    return [value(lo), value(hi)];
  });
}

async function decodePcm(ctx: OperationContext, channels: number, rate: number, duration: number) {
  const raw = ctx.tempPath('peaks.raw');
  await ctx.ffmpeg(
    [
      '-i',
      ctx.inputs.file[0],
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      // 显式指定声道数和采样率，PCM 文件的交错布局就确定了，不依赖探测结果
      '-ac',
      String(channels),
      '-ar',
      String(rate),
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      '-y',
      raw,
    ],
    { duration, range: [0, DECODE_SHARE] },
  );
  return raw;
}

export const peaks = defineOperation({
  name: 'analyze.peaks',
  route: '/api/analyze/peaks',
  title: '波形峰值',
  description:
    '生成音频播放器（wavesurfer.js 等）画波形用的峰值数据：把音轨分成 points 段，每段给出最小 / 最大采样值（-1 到 1）。',
  inputs: [fileInput('media', '音频或带音轨的视频')],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/analyze/peaks \\',
    '  -F "file=@song.mp3" -F "points=800"',
    '',
    '# URL 输入，左右声道分开，结果写成 JSON 文件',
    'curl -X POST http://localhost:9527/api/analyze/peaks \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/song.mp3","points":4000,"channels":"split","output":"file"}\'',
  ].join('\n'),
  notes: [
    '结果：{ duration, sampleRate, sourceSampleRate, sourceChannels, points, channels, mode, normalized, peaks }。mono 模式 peaks 是 [[min, max], …]；split 模式是每个声道一个这样的数组：[[[min, max], …], [[min, max], …]]。',
    '数值是采样值除以 32768，范围 -1 到 1，保留 4 位小数；normalize=true 时按全曲最大峰值放大到 ±1。',
    `音频先解码成低采样率的 PCM（默认 8 kHz，很长的音频最低 2 kHz，很短的音频会提高）再统计，所以 sampleRate 是分析用的采样率；split 模式最多 ${MAX_SPLIT_CHANNELS} 个声道。`,
    '音频的采样数少于 points 时，实际点数会变少（以结果里的 points 为准）。',
    'output=file 时峰值写成一个 JSON 文件（内容与 data 模式的结果相同），任务结果里不再包含 peaks，适合大点数、避免任务详情过大。',
    '多音轨文件只分析第一条音轨；没有音轨的文件直接失败。',
  ],
  async run(ctx, p) {
    const media = await probeInput(ctx, 'audio');
    const sourceChannels = media.audio?.channels ?? 0;
    let channels: number;
    if (p.channels === 'split') {
      if (sourceChannels > MAX_SPLIT_CHANNELS) {
        throw new Error(
          `split 模式最多支持 ${MAX_SPLIT_CHANNELS} 个声道，输入有 ${sourceChannels} 个，请改用 mono`,
        );
      }
      channels = sourceChannels > 0 ? sourceChannels : 2;
    } else {
      // mono 取所有声道的包络，不先混成单声道：反相的左右声道混音后会互相抵消
      channels = sourceChannels > 0 && sourceChannels <= MAX_SPLIT_CHANNELS ? sourceChannels : 2;
    }
    const rate = pickSampleRate(media.duration, p.points, channels);
    const raw = await decodePcm(ctx, channels, rate, media.duration);

    const stats = await computePeaks(
      raw,
      channels,
      p.points,
      (f) => ctx.progress(DECODE_SHARE + (1 - DECODE_SHARE) * f),
      ctx.signal,
    );
    await fs.promises.rm(raw, { force: true });

    const meta = {
      duration: round(stats.frames / rate, 3),
      sampleRate: rate,
      sourceSampleRate: media.audio?.sampleRate ?? 0,
      sourceChannels,
      points: stats.points,
      channels: p.channels === 'split' ? channels : 1,
      mode: p.channels,
      normalized: p.normalize,
    };
    const peakPairs = toPeakPairs(stats, p.channels, p.normalize);
    if (p.output === 'file') {
      const output = ctx.outputPath('json');
      await fs.promises.writeFile(output, JSON.stringify({ ...meta, peaks: peakPairs }));
      return { files: [output], primary: output, data: meta };
    }
    return { files: [], data: { ...meta, peaks: peakPairs } };
  },
});
