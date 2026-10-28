import { z } from 'zod';
import { parseTime } from '../../schemas/coerce';
import { probeRaw, summarizeProbe, type MediaSummary } from '../../utils/media-probe';
import type { InputSlot, OperationContext } from '../types';

/** 重新编码类操作的输出分辨率上限（横竖屏都按长边 7680、短边 4320 算） */
export const MAX_LONG_SIDE = 7680;
export const MAX_SHORT_SIDE = 4320;

export const VIDEO_INPUT: InputSlot[] = [
  { name: 'file', kind: 'video', required: true, description: '要处理的视频文件' },
];

interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  bit_rate?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { side_data_type?: string; rotation?: number }[];
  tags?: { rotate?: string };
}

interface RawProbe {
  streams?: RawStream[];
  format?: { duration?: string; format_name?: string; tags?: { major_brand?: string } };
}

export interface VideoInput {
  file: string;
  media: MediaSummary;
  /** 主画面在 ffprobe 里的流序号，用于 -map 0:N 和 [0:N]（跳过封面图） */
  videoIndex: number;
  videoCodec: string;
  /** 已按旋转元数据换算的显示宽高：ffmpeg 解码时默认自动旋转，滤镜看到的就是这个尺寸 */
  width: number;
  height: number;
  rotation: number;
  /** 帧率，取不到时为 0 */
  fps: number;
  /** 画面时长（秒），取不到时为 0 */
  duration: number;
  /** 所有音轨的编码名，按流顺序 */
  audioCodecs: string[];
  /** 第一条音轨的码率（bps），容器没写时为 0 */
  audioBitrate: number;
  formatName: string;
  majorBrand: string;
}

export function parseRate(rate: string): number {
  const [num, den] = rate.split('/').map(Number);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const value = den ? num / den : num;
  return Number.isFinite(value) ? value : 0;
}

function rotationOf(stream: RawStream): number {
  const matrix = stream.side_data_list?.find((d) => typeof d.rotation === 'number');
  const raw = matrix?.rotation ?? Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
}

/**
 * 探测输入视频。文件可能来自上传也可能来自 URL 下载，扩展名不可信，一切以 ffprobe 为准。
 * 用 probeRaw 而不是 ctx.probe：需要流序号、旋转、全部音轨和容器信息，MediaSummary 里没有
 */
export async function inspectVideo(ctx: OperationContext, file: string): Promise<VideoInput> {
  let raw: RawProbe;
  try {
    raw = (await probeRaw(file, ctx.signal)) as RawProbe;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(`无法解析输入文件，可能不是有效的视频: ${(err as Error).message}`);
  }
  const streams = raw.streams ?? [];
  const media = summarizeProbe(raw);
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video || !media.video) throw new Error('输入文件不包含视频画面');
  const codedW = video.width ?? 0;
  const codedH = video.height ?? 0;
  if (codedW <= 0 || codedH <= 0) throw new Error('无法识别输入视频的分辨率');
  const rotation = rotationOf(video);
  const swap = rotation === 90 || rotation === 270;
  const audio = streams.filter((s) => s.codec_type === 'audio');
  return {
    file,
    media,
    videoIndex: video.index ?? 0,
    videoCodec: video.codec_name ?? '',
    width: swap ? codedH : codedW,
    height: swap ? codedW : codedH,
    rotation,
    fps: parseRate(video.r_frame_rate ?? '') || parseRate(video.avg_frame_rate ?? ''),
    duration: media.video.duration || media.duration || 0,
    audioCodecs: audio.map((s) => s.codec_name ?? ''),
    audioBitrate: Number(audio[0]?.bit_rate) || 0,
    formatName: raw.format?.format_name ?? '',
    majorBrand: (raw.format?.tags?.major_brand ?? '').trim(),
  };
}

/** 重新编码前检查分辨率，过大的输入会占满内存、编码极慢 */
export function assertFrameSize(input: VideoInput): void {
  const long = Math.max(input.width, input.height);
  const short = Math.min(input.width, input.height);
  if (long > MAX_LONG_SIDE || short > MAX_SHORT_SIDE) {
    throw new Error(
      `视频分辨率 ${input.width}x${input.height} 超过上限 ${MAX_LONG_SIDE}x${MAX_SHORT_SIDE}`,
    );
  }
}

/** 时间、坐标等数字写进滤镜时的格式：最多 3 位小数，不出现科学计数法 */
export function num(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : rounded.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * 时间段 → 滤镜时间线表达式（带引号，逗号不会被当成滤镜分隔符）。都没给时返回 undefined，表示全程生效。
 * ffmpeg 默认把输入时间戳平移到从 0 开始，所以 t 就是相对视频开头的秒数
 */
export function enableExpr(start?: number, end?: number): string | undefined {
  const hasStart = start !== undefined && start > 0;
  if (!hasStart && end === undefined) return undefined;
  if (hasStart && end !== undefined) return `'between(t,${num(start)},${num(end)})'`;
  if (hasStart) return `'gte(t,${num(start)})'`;
  return `'lte(t,${num(end as number)})'`;
}

/** 给支持时间线的滤镜加上 enable 选项 */
export function withEnable(filter: string, enable?: string): string {
  if (!enable) return filter;
  return filter.includes('=') ? `${filter}:enable=${enable}` : `${filter}=enable=${enable}`;
}

/** 宽高有奇数时裁掉最后一行 / 列：yuv420p 要求偶数尺寸，裁 1 像素比缩放少一次重采样 */
export function evenCropFilter(width: number, height: number): string | undefined {
  if (width % 2 === 0 && height % 2 === 0) return undefined;
  return 'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0';
}

// mp4 能直接容纳且主流播放器都支持的音频编码，其余（pcm、vorbis、mp2 等）转成 AAC
const MP4_AUDIO_COPY = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac']);

/** 输出 mp4 时保留全部音轨：编码兼容就流复制，否则转 AAC；没有音轨时不加任何参数 */
export function keepAudioArgs(input: VideoInput): string[] {
  if (input.audioCodecs.length === 0) return [];
  const copy = input.audioCodecs.every((codec) => MP4_AUDIO_COPY.has(codec));
  return ['-map', '0:a', ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'])];
}

export const H264_ARGS = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-pix_fmt',
  'yuv420p',
];

/**
 * 「一条滤镜链处理画面、音频原样保留、输出 H.264 mp4」的通用命令。
 * chain 是逗号连接的滤镜串，会自动接在 [0:主画面] 后面并补上偶数尺寸裁剪
 */
export function filterChainArgs(input: VideoInput, filters: string[], output: string): string[] {
  const chain = [...filters];
  const even = evenCropFilter(input.width, input.height);
  if (even) chain.push(even);
  if (chain.length === 0) chain.push('null');
  return graphArgs(input, `[0:${input.videoIndex}]${chain.join(',')}[vout]`, output);
}

/** 自定义 filter_complex（输出标签必须是 [vout]）+ 保留音轨 + H.264 mp4 */
export function graphArgs(input: VideoInput, graph: string, output: string): string[] {
  return [
    '-i',
    input.file,
    '-filter_complex',
    graph,
    '-map',
    '[vout]',
    ...keepAudioArgs(input),
    ...H264_ARGS,
    '-movflags',
    '+faststart',
    '-y',
    output,
  ];
}

/** 时间窗口参数的通用检查：结束必须晚于开始 */
export function checkTimeWindow(start?: number, end?: number): string | undefined {
  if (start !== undefined && end !== undefined && end <= start) {
    return 'endTime 必须大于 startTime';
  }
  return undefined;
}

/** 探测后才能做的检查：开始时间不能超出视频时长 */
export function assertStartInside(
  start: number | undefined,
  duration: number,
  label = 'startTime',
): void {
  if (start !== undefined && duration > 0 && start >= duration) {
    throw new Error(`${label}（${num(start)} 秒）超出视频时长（${num(duration)} 秒）`);
  }
}

// ---------- 区域（模糊、去水印共用） ----------

export const MAX_REGIONS = 10;
/** 坐标绝对值上限，挡住 1e308 这类会让后续计算溢出的值 */
const MAX_COORD = 100000;

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  startTime?: number;
  endTime?: number;
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return Number.NaN;
}

function regionFromArray(values: unknown[]): Region | undefined {
  if (values.length !== 4) return undefined;
  const [x, y, width, height] = values.map(toNum);
  return { x, y, width, height };
}

function regionFromObject(obj: Record<string, unknown>): Region | string | undefined {
  const pick = (...keys: string[]) => keys.map((k) => obj[k]).find((v) => v !== undefined);
  const width = pick('width', 'w');
  const height = pick('height', 'h');
  if (obj.x === undefined || obj.y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  const region: Region = {
    x: toNum(obj.x),
    y: toNum(obj.y),
    width: toNum(width),
    height: toNum(height),
  };
  for (const [key, aliases] of [
    ['startTime', ['startTime', 'start']],
    ['endTime', ['endTime', 'end']],
  ] as const) {
    const raw = pick(...aliases);
    if (raw === undefined || raw === null || raw === '') continue;
    const seconds = parseTime(raw);
    if (seconds === undefined) return `${key} 必须是秒数或 HH:MM:SS 格式的时间`;
    region[key] = seconds;
  }
  return region;
}

/** 把各种写法的区域统一成数组；返回 string 表示错误信息 */
export function parseRegions(value: unknown, name: string): Region[] | string | undefined {
  const format = `应为 {x,y,width,height} 对象、[x,y,w,h] 数组或 "x,y,w,h" 字符串`;
  if (value === undefined || value === null) return undefined;
  let data: unknown = value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return undefined;
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        data = JSON.parse(s) as unknown;
      } catch {
        return `${name} 不是合法的 JSON`;
      }
    } else {
      data = s
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.split(/\s*,\s*|\s+/));
    }
  }
  let list: unknown[];
  if (Array.isArray(data)) {
    // 只有一个区域时也接受扁平的 [x,y,w,h]
    const flat = data.length === 4 && data.every((v) => !Array.isArray(v) && !isObject(v));
    list = flat ? [data] : data;
  } else if (isObject(data)) {
    list = [data];
  } else {
    return `${name} 格式不正确，${format}`;
  }
  if (list.length === 0) return undefined;
  if (list.length > MAX_REGIONS) return `${name} 最多 ${MAX_REGIONS} 个区域`;

  const regions: Region[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const label = `${name} 第 ${i + 1} 个区域`;
    const parsed = Array.isArray(item)
      ? regionFromArray(item)
      : isObject(item)
        ? regionFromObject(item)
        : undefined;
    if (parsed === undefined) return `${label}格式不正确，${format}`;
    if (typeof parsed === 'string') return `${label}的 ${parsed}`;
    const coords = [parsed.x, parsed.y, parsed.width, parsed.height];
    if (!coords.every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_COORD)) {
      return `${label}的坐标必须是数字（绝对值不超过 ${MAX_COORD}）`;
    }
    if (parsed.width <= 0 || parsed.height <= 0) return `${label}的宽和高必须大于 0`;
    if (
      parsed.startTime !== undefined &&
      parsed.endTime !== undefined &&
      parsed.endTime <= parsed.startTime
    ) {
      return `${label}的 endTime 必须大于 startTime`;
    }
    regions.push(parsed);
  }
  return regions;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 区域列表参数：multipart 里是字符串（JSON 或 x,y,w,h;…），JSON body 里可以直接是数组 */
export function regionsParam(name: string) {
  return z.unknown().transform((value, ctx): Region[] | undefined => {
    const result = parseRegions(value, name);
    if (typeof result === 'string') {
      ctx.addIssue(result);
      return z.NEVER;
    }
    return result;
  });
}

export type Unit = 'px' | 'percent';

/** 百分比坐标换算成像素（相对显示尺寸） */
export function toPixels(region: Region, unit: Unit, width: number, height: number): Region {
  if (unit === 'px') return region;
  return {
    ...region,
    x: (region.x / 100) * width,
    y: (region.y / 100) * height,
    width: (region.width / 100) * width,
    height: (region.height / 100) * height,
  };
}
