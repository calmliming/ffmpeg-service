import { z } from 'zod';
import { enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  ZERO_PTS,
  decodedDuration,
  encodeAudio,
  num,
  outputFields,
  prepareSingle,
  rethrowWith,
} from './format';

const WHERE = ['start', 'end', 'both', 'all'] as const;
type Where = (typeof WHERE)[number];

/** 保留区间超过这个数时 aselect 表达式过长，求值也慢 */
export const MAX_SEGMENTS = 1000;
/** 静音段起点 / 终点离文件头尾在这个范围内就算开头 / 结尾的静音（秒） */
const EDGE = 0.05;

export interface Silence {
  start: number;
  end: number;
}

/** 解析 silencedetect 打印的 silence_start / silence_end；结尾的静音没有 end 时补到 total */
export function parseSilences(stderr: string, total: number): Silence[] {
  const silences: Silence[] = [];
  let open: number | undefined;
  const pattern = /silence_(start|end):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi;
  for (const match of stderr.matchAll(pattern)) {
    const value = Math.max(0, Number(match[2]));
    if (!Number.isFinite(value)) continue;
    if (match[1].toLowerCase() === 'start') {
      open = value;
    } else {
      silences.push({ start: open ?? 0, end: value });
      open = undefined;
    }
  }
  if (open !== undefined && total > open) silences.push({ start: open, end: total });
  return silences;
}

export interface KeepOptions {
  where: Where;
  /** all 模式下中间静音保留的最长秒数 */
  maxGap: number;
  /** 去掉开头 / 结尾静音时保留的静音秒数 */
  padding: number;
}

/** 根据静音段算出要保留的区间（秒），按时间排序、互不重叠；全部是静音时返回空数组 */
export function keepRanges(silences: Silence[], total: number, o: KeepOptions): [number, number][] {
  let begin = 0;
  let finish = total;
  const first = silences[0];
  const last = silences[silences.length - 1];
  if (o.where !== 'end' && first && first.start <= EDGE) {
    begin = Math.max(0, first.end - o.padding);
  }
  if (o.where !== 'start' && last && last.end >= total - EDGE) {
    finish = Math.min(total, last.start + o.padding);
  }
  if (finish - begin <= 0.001) return [];

  const ranges: [number, number][] = [];
  let cursor = begin;
  if (o.where === 'all') {
    for (const s of silences) {
      // 开头和结尾的静音上面已经处理过
      if (s.start <= begin || s.end >= finish) continue;
      if (s.end - s.start <= o.maxGap) continue;
      // 静音两边各留一半，切口落在静音中间，不会切到声音
      const cutStart = s.start + o.maxGap / 2;
      const cutEnd = s.end - o.maxGap / 2;
      if (cutStart > cursor) ranges.push([cursor, cutStart]);
      cursor = Math.max(cursor, cutEnd);
    }
  }
  ranges.push([cursor, finish]);
  return ranges.filter(([a, b]) => b - a > 0.0005);
}

/**
 * 只有一段时用 atrim，按采样点精确裁剪；多段时把音频切成约 5 ms 的小帧再用 aselect 选取，
 * 不像 asplit + atrim + concat 那样要把后面的片段整个缓存在内存里
 */
export function cutFilter(ranges: [number, number][], total: number, sampleRate: number): string {
  const isEnd = (t: number) => t >= total - 1e-6;
  if (ranges.length === 1) {
    const [a, b] = ranges[0];
    const opts = [a > 0 ? `start=${num(a)}` : '', isEnd(b) ? '' : `end=${num(b)}`].filter(Boolean);
    if (opts.length === 0) return 'anull';
    return `atrim=${opts.join(':')},asetpts=PTS-STARTPTS`;
  }
  const frame = Math.max(32, Math.round((sampleRate || 48000) * 0.005));
  const expr = ranges
    .map(([a, b]) => (isEnd(b) ? `gte(t,${num(a)})` : `between(t,${num(a)},${num(b)})`))
    .join('+');
  return `asetnsamples=n=${frame}:p=0,aselect='${expr}',asetpts=N/SR/TB`;
}

export const trimSilenceOperation = defineOperation({
  name: 'audio.trim-silence',
  route: '/api/audio/trim-silence',
  title: '去除静音',
  description:
    '自动检测并去掉开头、结尾的静音，也可以把中间过长的停顿缩短到指定长度，常用于录音、播客和配音的后期整理。',
  inputs: [
    {
      name: 'file',
      kind: 'media',
      required: true,
      description: '音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频）',
    },
  ],
  chainable: true,
  params: z.object({
    threshold: numberParam('threshold', { min: -90, max: -10 }).default(-50).meta({
      description:
        '静音阈值（dB，-90 到 -10），低于它算静音，默认 -50；有底噪的录音可以调到 -40 或 -35',
    }),
    minSilence: numberParam('minSilence', { min: 0.05, max: 60 })
      .default(0.5)
      .meta({ description: '最短静音时长（秒，0.05-60），短于它的停顿不处理，默认 0.5' }),
    where: enumParam('where', WHERE).default('both').meta({
      description:
        '处理位置：start 只去开头 / end 只去结尾 / both 开头和结尾（默认）/ all 开头结尾都去，并把中间超过 maxGap 的停顿缩短到 maxGap',
    }),
    maxGap: numberParam('maxGap', { min: 0, max: 10 }).default(0.5).meta({
      description: 'where=all 时中间停顿保留的最长秒数（0-10），默认 0.5；0 表示完全去掉',
    }),
    padding: numberParam('padding', { min: 0, max: 5 })
      .default(0)
      .meta({ description: '去掉开头 / 结尾静音时各保留多少秒静音（0-5），避免声音贴边，默认 0' }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/trim-silence -F "file=@recording.wav" -F "threshold=-45"',
    '',
    '# 去掉首尾静音，并把中间超过 0.3 秒的停顿缩短到 0.3 秒',
    'curl -X POST http://localhost:9527/api/audio/trim-silence -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/podcast.mp3", "where": "all", "minSilence": 0.3, "maxGap": 0.3}\'',
  ].join('\n'),
  notes: [
    '两遍处理：先用 silencedetect 找出静音段（进度 0-30%），再按算出的保留区间剪切输出',
    '静音判断是所有声道都低于 threshold 才算静音',
    '只保留一段时按采样点精确裁剪；where=all 产生多段时以约 5 ms 为单位拼接，切口都落在静音里，不会有爆音',
    `中间保留区间最多 ${MAX_SEGMENTS} 段，超过时请调大 minSilence`,
    '整段都是静音时任务失败；没有可去除的静音时照常输出（data.removed 为 0）',
    '任务结果 data：originalDuration、duration、removed（去掉的秒数）、silences（检测到的静音段数）、segments（保留的段数）',
  ],
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);

    ctx.progress(0, { phase: 'analyzing' });
    // 检测和剪切（encodeAudio 同样先归零）用同一条从 0 开始的时间轴：音轨晚于文件开头时，
    // 不归零的话开头静音的 silence_start 是音轨的起始时间戳而不是 0，认不出是开头的静音
    const detect = `${ZERO_PTS},silencedetect=noise=${num(params.threshold, 2)}dB:d=${num(params.minSilence, 3)}`;
    const { stderr } = await ctx
      .ffmpeg(['-i', file, '-map', '0:a:0', '-af', detect, '-f', 'null', '-'], {
        duration: media.audioDuration,
        range: [0, 0.3],
        logLevel: 'info',
        captureStderr: true,
      })
      .catch(rethrowWith(ctx, '静音检测失败'));

    const total = decodedDuration(stderr) ?? media.audioDuration;
    const silences = parseSilences(stderr, total);
    const ranges = keepRanges(silences, total, {
      where: params.where,
      maxGap: params.maxGap,
      padding: params.padding,
    });
    if (ranges.length === 0) {
      throw new Error(`整段音频都低于 ${params.threshold} dB，没有可保留的声音`);
    }
    if (ranges.length > MAX_SEGMENTS) {
      throw new Error(
        `检测到的停顿太多（保留区间 ${ranges.length} 段，上限 ${MAX_SEGMENTS}），请调大 minSilence 或调低 threshold`,
      );
    }
    const kept = ranges.reduce((sum, [a, b]) => sum + b - a, 0);

    ctx.progress(0.3, { phase: 'processing' });
    const output = await encodeAudio(ctx, {
      inputs: [file],
      filter: cutFilter(ranges, total, media.audio.sampleRate),
      encode: { format, bitrate: params.bitrate, inputChannels: media.audio.channels },
      duration: kept,
      range: [0.3, 1],
      errorPrefix: '去除静音失败',
    });

    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
      files: [output],
      data: {
        originalDuration: round(total),
        duration: round(kept),
        removed: round(Math.max(0, total - kept)),
        silences: silences.length,
        segments: ranges.length,
      },
    };
  },
});
