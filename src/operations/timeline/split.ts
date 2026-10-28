import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { enumParam, numberParam, parseTime, timeParam, toList } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AUDIO_ENCODE,
  FASTSTART,
  VIDEO_ENCODE,
  copyContainer,
  evenSizeFilters,
  fmtSec,
  mainDuration,
  probeInput,
  reencodeExt,
  sec,
  streamMaps,
} from './shared';

export const MAX_PARTS = 100;
/** 比这更短的片段并进前一段，避免切出只有一两帧的文件 */
const MIN_PART = 0.1;

export interface Piece {
  start: number;
  end: number;
}

export type SplitBy = { segmentDuration: number } | { timestamps: number[] } | { parts: number };

/** 根据分段方式算出每一段的起止时间 */
export function planSplit(by: SplitBy, total: number): Piece[] {
  let points: number[];
  if ('segmentDuration' in by) {
    const d = by.segmentDuration;
    const count = Math.ceil(total / d - 1e-6);
    if (count > MAX_PARTS) {
      throw new Error(
        `按每段 ${fmtSec(d)} 秒分割会得到 ${count} 段，超过上限 ${MAX_PARTS} 段，请加大 segmentDuration`,
      );
    }
    points = Array.from({ length: Math.max(0, count - 1) }, (_, i) => (i + 1) * d);
  } else if ('timestamps' in by) {
    for (const t of by.timestamps) {
      if (t >= total) {
        throw new Error(`分割点 ${fmtSec(t)} 秒超出了时长 ${fmtSec(total)} 秒`);
      }
    }
    points = by.timestamps.filter((t) => t > 0);
  } else {
    points = Array.from({ length: by.parts - 1 }, (_, i) => ((i + 1) * total) / by.parts);
  }

  const sorted = [...new Set(points)].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  let start = 0;
  for (const point of [...sorted, total]) {
    if (point - start < MIN_PART) {
      // 太短的片段并进下一段；结尾的零头并进最后一段
      if (point === total && pieces.length > 0) pieces[pieces.length - 1].end = total;
      continue;
    }
    pieces.push({ start, end: point });
    start = point;
  }
  if (pieces.length === 0) pieces.push({ start: 0, end: total });
  return pieces;
}

/**
 * 解析 segment 封装器 -segment_list_type csv 写出的列表：每行「文件名,开始秒,结束秒」，
 * 文件名含逗号或引号时会被加上双引号。返回文件名到起止时间的映射，格式不对的行跳过
 */
export function parseSegmentList(csv: string): Map<string, Piece> {
  const spans = new Map<string, Piece>();
  for (const line of csv.split(/\r?\n/)) {
    const match = /^(.+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1].replace(/^"(.*)"$/, '$1').replace(/""/g, '"');
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (end >= start) spans.set(name, { start, end });
  }
  return spans;
}

const timestampList = z
  .preprocess(
    (value, ctx) => {
      const list = toList(value);
      if (!Array.isArray(list)) return list;
      if (list.length > MAX_PARTS - 1) {
        ctx.issues.push({
          code: 'custom',
          message: `timestamps 最多 ${MAX_PARTS - 1} 个分割点`,
          input: value,
        });
        return z.NEVER;
      }
      const result: number[] = [];
      for (let i = 0; i < list.length; i++) {
        const t = parseTime(list[i]);
        if (t === undefined) {
          ctx.issues.push({
            code: 'custom',
            message: `timestamps 第 ${i + 1} 个时间格式不对，应为秒数或 HH:MM:SS`,
            input: value,
          });
          return z.NEVER;
        }
        result.push(t);
      }
      return result;
    },
    z
      .array(z.number(), { error: 'timestamps 必须是时间列表，如 10,25.5,00:01:00' })
      .min(1, { error: 'timestamps 至少要有一个分割点' }),
  )
  .optional();

export const splitOperation = defineOperation({
  name: 'video.split',
  route: '/api/video/split',
  title: '分割视频',
  description:
    '把一个视频（或音频）切成多个文件：按固定时长、在指定时间点、或平均分成 N 段。可以逐帧精确重新编码，也可以按关键帧快速流复制。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '视频或音频文件' }],
  params: z.object({
    segmentDuration: timeParam('segmentDuration')
      .refine((value) => value >= 0.5, { error: 'segmentDuration 至少 0.5 秒' })
      .optional()
      .meta({ description: '按固定时长分割，每段秒数（或 HH:MM:SS），最后一段可能更短' }),
    timestamps: timestampList.meta({
      description: '在这些时间点切开，逗号分隔或数组，如 10,25.5,00:01:00；最多 99 个',
    }),
    parts: numberParam('parts', { min: 2, max: MAX_PARTS, int: true })
      .optional()
      .meta({
        description: `平均分成几段，2-${MAX_PARTS}`,
      }),
    mode: enumParam('mode', ['accurate', 'fast']).default('accurate').meta({
      description:
        'accurate（默认）逐段重新编码，切点逐帧精确；fast 流复制，速度快、画质无损，但只能在关键帧处切开，实际切点会推后到下一个关键帧',
    }),
  }),
  check(params) {
    const given = [params.segmentDuration, params.timestamps, params.parts].filter(
      (value) => value !== undefined,
    );
    if (given.length !== 1) return 'segmentDuration、timestamps、parts 必须且只能提供一个';
    return undefined;
  },
  example: [
    '# 每 60 秒切一段',
    'curl -X POST http://localhost:9527/api/video/split \\',
    '  -F "file=@video.mp4" \\',
    '  -F "segmentDuration=60"',
    '',
    '# 在指定时间点快速切开（URL 输入）',
    'curl -X POST http://localhost:9527/api/video/split \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","timestamps":["00:01:00","00:02:30"],"mode":"fast"}\'',
  ].join('\n'),
  notes: [
    `最多 ${MAX_PARTS} 段；segmentDuration、timestamps、parts 三选一。`,
    `短于 ${MIN_PART} 秒的零头会并进相邻的一段。`,
    '产物按顺序命名为 part_001、part_002…，放在同一个目录里；任务结果 data.parts 列出每段的 index、start、end、duration 和文件名 file。',
    'accurate 输出 MP4（纯音频为 M4A）；fast 流复制，容器按原编码选择（H.264 / HEVC + AAC 为 MP4，其他为 MKV 等）。',
    'fast 模式只能在关键帧切开，关键帧间隔大的视频实际段数可能少于请求的段数，data.parts 给出的是实际起止时间。',
  ],
  async run(ctx, params) {
    const input = ctx.inputs.file[0];
    const media = await probeInput(ctx, input);
    const total = mainDuration(media);
    const by: SplitBy =
      params.segmentDuration !== undefined
        ? { segmentDuration: params.segmentDuration }
        : params.timestamps !== undefined
          ? { timestamps: params.timestamps }
          : { parts: params.parts ?? 2 };
    const pieces = planSplit(by, total);
    const dir = await ctx.outputDir();
    ctx.progress(0, { phase: 'processing' });

    let files: string[];
    let spans: Piece[];
    if (params.mode === 'fast') {
      const container = copyContainer(media);
      const points = pieces.slice(1).map((piece) => sec(piece.start));
      // 流复制只能在关键帧处切开，实际切点由 segment 封装器写进列表（中间文件，不对外提供）
      const list = ctx.tempPath('split_parts.csv');
      const args = ['-i', input, ...streamMaps(media), '-c', 'copy', ...container.extraArgs];
      args.push('-f', 'segment', '-segment_format', container.format);
      if (points.length > 0) args.push('-segment_times', points.join(','));
      args.push('-segment_start_number', '1', '-reset_timestamps', '1');
      args.push('-segment_list', list, '-segment_list_type', 'csv');
      // 带 B 帧的视频 dts 从负数开始，外层 segment 封装器默认把整条时间线后移两三帧，列表里的切点跟着偏移。
      // 关掉外层的平移，负 dts 交给每一段自己的 mp4 / mkv 封装器处理，产物不变，列表就是原片时间
      args.push('-avoid_negative_ts', 'disabled');
      if (container.movflags) args.push('-segment_format_options', 'movflags=+faststart');
      args.push('-y', path.join(dir, `part_%03d.${container.ext}`));
      await ctx.ffmpeg(args, { duration: total });

      const pattern = new RegExp(`^part_\\d{3}\\.${container.ext}$`);
      files = (await fs.promises.readdir(dir))
        .filter((name) => pattern.test(name))
        .sort()
        .map((name) => path.join(dir, name));
      if (files.length === 0) throw new Error('分割失败，没有生成任何文件');
      const listed = parseSegmentList(await fs.promises.readFile(list, 'utf8').catch(() => ''));
      spans = [];
      let cursor = 0;
      for (const file of files) {
        const span = listed.get(path.basename(file));
        if (span) {
          spans.push(span);
          cursor = span.end;
          continue;
        }
        // 列表里没有这一段时（理论上不会发生）退回量文件时长；mkv 的文件时长含起始偏移，会略有误差
        const info = await ctx.probe(file);
        const length = info.video?.duration || info.duration;
        spans.push({ start: cursor, end: cursor + length });
        cursor += length;
      }
    } else {
      const ext = reencodeExt(media);
      files = [];
      for (let i = 0; i < pieces.length; i++) {
        const { start, end } = pieces[i];
        const file = path.join(dir, `part_${String(i + 1).padStart(3, '0')}.${ext}`);
        // -ss / -t 放在 -i 前：输入端定位只解码需要的部分，重新编码时也是逐帧精确的
        const args = start > 0 ? ['-ss', sec(start)] : [];
        args.push('-t', sec(end - start), '-i', input, ...streamMaps(media));
        if (media.video) {
          const filters = evenSizeFilters(media);
          if (filters.length > 0) args.push('-vf', filters.join(','));
          args.push(...VIDEO_ENCODE);
        }
        if (media.audio) args.push(...AUDIO_ENCODE);
        args.push(...FASTSTART, '-y', file);
        ctx.progress(start / total, {
          phase: 'processing',
          currentVideoIndex: i + 1,
          totalVideos: pieces.length,
        });
        await ctx.ffmpeg(args, { duration: end - start, range: [start / total, end / total] });
        files.push(file);
      }
      spans = pieces;
    }

    return {
      files,
      primary: files[0],
      data: {
        mode: params.mode,
        count: files.length,
        parts: files.map((file, i) => ({
          index: i + 1,
          start: Number(spans[i].start.toFixed(3)),
          end: Number(spans[i].end.toFixed(3)),
          duration: Number((spans[i].end - spans[i].start).toFixed(3)),
          file: path.basename(file),
        })),
      },
    };
  },
});
