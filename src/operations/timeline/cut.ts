import { z } from 'zod';
import { enumParam, parseTime } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AUDIO_ENCODE,
  FASTSTART,
  VIDEO_ENCODE,
  evenSizeFilters,
  fmtSec,
  mainDuration,
  probeInput,
  reencodeExt,
  sec,
} from './shared';

export const MAX_RANGES = 100;
/** 区间终点允许超出时长的误差：探测到的时长和客户端看到的时长常差一两帧 */
const END_TOLERANCE = 0.05;
/** 短于这个长度的片段（不到一帧）直接丢掉，concat 遇到空片段会出错 */
const MIN_PIECE = 0.02;

export interface TimeRange {
  start: number;
  /** 省略表示到结尾 */
  end?: number;
}

const FORMAT_HINT = '应为 开始-结束，如 10-20 或 00:00:10-00:00:20，结束可省略表示到结尾（如 35-）';

function display(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function parseItem(item: unknown): TimeRange | undefined {
  if (typeof item === 'string') {
    const parts = item.trim().split('-');
    if (parts.length !== 2) return undefined;
    const start = parseTime(parts[0]);
    if (start === undefined) return undefined;
    if (parts[1].trim() === '') return { start };
    const end = parseTime(parts[1]);
    return end === undefined ? undefined : { start, end };
  }
  if (Array.isArray(item)) {
    if (item.length < 1 || item.length > 2) return undefined;
    return parseItem({ start: item[0], end: item[1] });
  }
  if (item && typeof item === 'object') {
    const { start, end } = item as { start?: unknown; end?: unknown };
    const s = parseTime(start);
    if (s === undefined) return undefined;
    const blank =
      end === undefined || end === null || (typeof end === 'string' && end.trim() === '');
    if (blank) return { start: s };
    const e = parseTime(end);
    return e === undefined ? undefined : { start: s, end: e };
  }
  return undefined;
}

/**
 * 把 ranges 参数解析成区间数组。接受 "10-20,35.5-40" 字符串、JSON 数组字符串、
 * 字符串数组、[开始, 结束] 数组和 {start, end} 对象数组；出错时返回中文错误信息
 */
export function parseRanges(value: unknown): TimeRange[] | string {
  let items: unknown[];
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) return `ranges 格式不对，${FORMAT_HINT}`;
        items = parsed;
      } catch {
        return 'ranges 不是合法的 JSON 数组';
      }
    } else {
      items = text.split(',').filter((item) => item.trim() !== '');
    }
  } else if (Array.isArray(value)) {
    // multipart 里 ranges 字段重复出现时是字符串数组，每一项也可能是逗号列表
    items = value.flatMap((item) =>
      typeof item === 'string' ? item.split(',').filter((part) => part.trim() !== '') : [item],
    );
  } else {
    return `请提供 ranges，${FORMAT_HINT}`;
  }
  if (items.length === 0) return `请提供 ranges，${FORMAT_HINT}`;
  if (items.length > MAX_RANGES) return `ranges 最多 ${MAX_RANGES} 个区间，当前 ${items.length} 个`;

  const ranges: TimeRange[] = [];
  for (let i = 0; i < items.length; i++) {
    const range = parseItem(items[i]);
    if (!range) return `ranges 第 ${i + 1} 个区间 "${display(items[i])}" 格式不对，${FORMAT_HINT}`;
    if (range.end !== undefined && range.end <= range.start) {
      return `ranges 第 ${i + 1} 个区间的结束时间必须大于开始时间`;
    }
    ranges.push(range);
  }
  return ranges;
}

export interface Span {
  start: number;
  end: number;
}

/** 按时长校验区间、合并重叠部分，算出要保留和要删除的片段（都按时间顺序） */
export function planCut(
  ranges: TimeRange[],
  total: number,
  mode: 'remove' | 'keep',
): { kept: Span[]; removed: Span[] } {
  const spans: Span[] = ranges.map((range, i) => {
    if (range.start >= total - 1e-3) {
      throw new Error(
        `ranges 第 ${i + 1} 个区间的开始时间 ${fmtSec(range.start)} 秒超出了时长 ${fmtSec(total)} 秒`,
      );
    }
    if (range.end !== undefined && range.end > total + END_TOLERANCE) {
      throw new Error(
        `ranges 第 ${i + 1} 个区间的结束时间 ${fmtSec(range.end)} 秒超出了时长 ${fmtSec(total)} 秒`,
      );
    }
    return { start: range.start, end: Math.min(range.end ?? total, total) };
  });

  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 1e-3) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const complement: Span[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) complement.push({ start: cursor, end: span.start });
    cursor = span.end;
  }
  if (cursor < total) complement.push({ start: cursor, end: total });

  const longEnough = (span: Span) => span.end - span.start >= MIN_PIECE;
  const kept = (mode === 'keep' ? merged : complement).filter(longEnough);
  const removed = (mode === 'keep' ? complement : merged).filter(longEnough);
  if (kept.length === 0) {
    throw new Error(
      mode === 'keep' ? '要保留的区间太短，没有可输出的内容' : '删除这些区间后没有剩余内容',
    );
  }
  return { kept, removed };
}

const round = (span: Span): Span => ({
  start: Number(span.start.toFixed(3)),
  end: Number(span.end.toFixed(3)),
});

export const cutOperation = defineOperation({
  name: 'video.cut',
  route: '/api/video/cut',
  title: '多段剪切',
  description:
    '一次删除视频中的多个时间段（如去掉片头、广告、口误），或只保留指定的几段并按时间顺序拼起来。逐帧精确。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '视频或音频文件' }],
  params: z.object({
    ranges: z
      .preprocess(
        (value, ctx) => {
          const result = parseRanges(value);
          if (typeof result === 'string') {
            ctx.issues.push({ code: 'custom', message: result, input: value });
            return z.NEVER;
          }
          return result;
        },
        z.array(z.object({ start: z.number(), end: z.number().optional() })),
      )
      .meta({
        description:
          '时间区间列表。字符串 "10-20,35.5-40" 或 "00:00:10-00:00:20"，也可以传数组（["10-20"]、[[10,20]]、[{"start":10,"end":20}]）；结束省略表示到结尾，如 "35-"。最多 100 个',
      }),
    mode: enumParam('mode', ['remove', 'keep']).default('remove').meta({
      description: 'remove（默认）删除这些区间、保留其余部分；keep 只保留这些区间',
    }),
  }),
  chainable: true,
  example: [
    '# 删掉 10-20 秒和 35.5-40 秒',
    'curl -X POST http://localhost:9527/api/video/cut \\',
    '  -F "file=@video.mp4" \\',
    '  -F "ranges=10-20,35.5-40"',
    '',
    '# 只保留两段（URL 输入）',
    'curl -X POST http://localhost:9527/api/video/cut \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","mode":"keep","ranges":[{"start":"00:01:00","end":"00:01:30"},{"start":120,"end":150}]}\'',
  ].join('\n'),
  notes: [
    `最多 ${MAX_RANGES} 个区间。区间会按时间排序，重叠或相接的区间自动合并；keep 模式也按时间顺序输出，不能调换片段顺序。`,
    `区间开始时间超出时长、或结束时间超出时长 ${END_TOLERANCE} 秒以上时报错；在误差内的按时长截断。`,
    '用 trim / atrim + concat 滤镜重新编码，切点逐帧精确；只解码第一段开始到最后一段结束之间的内容。',
    '纯音频文件也可以剪切，输出 m4a（AAC）。',
    '任务结果 data 里有 kept（保留的片段）、removed（删除的片段）和 duration（输出时长）。',
  ],
  async run(ctx, params) {
    const input = ctx.inputs.file[0];
    const media = await probeInput(ctx, input);
    const total = mainDuration(media);
    const { kept, removed } = planCut(params.ranges, total, params.mode);
    const duration = kept.reduce((sum, span) => sum + (span.end - span.start), 0);

    // 只解码需要的范围：输入端 -ss 精确定位后时间戳从 0 开始，所以后面的区间都要减去 offset
    const offset = kept[0].start;
    const last = kept[kept.length - 1].end;
    const args: string[] = [];
    if (offset > 0) args.push('-ss', sec(offset));
    if (last < total - 1e-3) args.push('-to', sec(last));
    args.push('-i', input);

    const n = kept.length;
    const trims = kept.map(
      (span) => `start=${sec(span.start - offset)}:end=${sec(span.end - offset)}`,
    );
    const graph: string[] = [];
    const concatInputs: string[] = [];
    // 一个输入只能连一个滤镜，多段时先 split；区间按时间顺序，split 出来的帧不会长时间积压
    if (media.video) {
      graph.push(
        n > 1 ? `[0:V:0]split=${n}${trims.map((_, i) => `[vs${i}]`).join('')}` : '[0:V:0]null[vs0]',
      );
      trims.forEach((trim, i) => graph.push(`[vs${i}]trim=${trim},setpts=PTS-STARTPTS[v${i}]`));
    }
    if (media.audio) {
      graph.push(
        n > 1
          ? `[0:a:0]asplit=${n}${trims.map((_, i) => `[as${i}]`).join('')}`
          : '[0:a:0]anull[as0]',
      );
      trims.forEach((trim, i) => graph.push(`[as${i}]atrim=${trim},asetpts=PTS-STARTPTS[a${i}]`));
    }
    for (let i = 0; i < n; i++) {
      if (media.video) concatInputs.push(`[v${i}]`);
      if (media.audio) concatInputs.push(`[a${i}]`);
    }
    const outLabels = `${media.video ? '[vc]' : ''}${media.audio ? '[ac]' : ''}`;
    graph.push(
      `${concatInputs.join('')}concat=n=${n}:v=${media.video ? 1 : 0}:a=${media.audio ? 1 : 0}${outLabels}`,
    );
    if (media.video) graph.push(`[vc]${['null', ...evenSizeFilters(media)].join(',')}[v]`);

    args.push('-filter_complex', graph.join(';'));
    if (media.video) args.push('-map', '[v]', ...VIDEO_ENCODE);
    if (media.audio) args.push('-map', '[ac]', ...AUDIO_ENCODE);
    const output = ctx.outputPath(reencodeExt(media));
    args.push(...FASTSTART, '-y', output);

    ctx.progress(0, { phase: 'processing' });
    await ctx.ffmpeg(args, { duration });
    return {
      files: [output],
      data: {
        mode: params.mode,
        kept: kept.map(round),
        removed: removed.map(round),
        duration: Number(duration.toFixed(3)),
      },
    };
  },
});
