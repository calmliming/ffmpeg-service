import { z } from 'zod';
import { probeRaw, summarizeProbe, type MediaSummary } from '../../utils/media-probe';
import { enumParam } from '../../schemas/coerce';
import type { OperationContext } from '../types';

/** 输出画面上限：横屏 7680x4320，竖屏 4320x7680 */
export const MAX_LONG_SIDE = 7680;
export const MAX_SHORT_SIDE = 4320;

export const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '21:9'] as const;
export type Aspect = (typeof ASPECTS)[number];

export function aspectParam(name = 'aspect') {
  return enumParam(name, ASPECTS);
}

export function parseAspect(aspect: Aspect): { w: number; h: number } {
  const [w, h] = aspect.split(':').map(Number);
  return { w, h };
}

/** 向下取偶数，最小 2。yuv420p 的宽高必须是偶数，libx264 遇到奇数直接报错 */
export function evenFloor(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** 四舍五入到偶数，最小 2 */
export function evenRound(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** 坐标向下取偶数（4:2:0 色度按 2 像素对齐），最小 0 */
export function evenOffset(n: number): number {
  return Math.max(0, Math.floor(n / 2) * 2);
}

export function fitsMaxSize(width: number, height: number): boolean {
  return Math.max(width, height) <= MAX_LONG_SIDE && Math.min(width, height) <= MAX_SHORT_SIDE;
}

export function maxSizeError(what: string, width: number, height: number): string {
  return `${what} ${width}x${height} 超过上限 ${MAX_LONG_SIDE}x${MAX_SHORT_SIDE}（竖屏 ${MAX_SHORT_SIDE}x${MAX_LONG_SIDE}）`;
}

/** 视频编码默认参数：H.264 + yuv420p，浏览器和手机都能播 */
export const VIDEO_ENCODE = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-pix_fmt',
  'yuv420p',
];

export const AAC_ENCODE = ['-c:a', 'aac', '-b:a', '192k'];

// 只直接复制 mp4 里浏览器普遍能播的音频编码；opus / flac / pcm / ac3 等转成 AAC，保证产物是标准的 H.264/AAC mp4
const MP4_COPY_AUDIO = new Set(['aac', 'mp3']);

/** 滤镜图不处理音频时的音频编码参数：能复制就复制，否则转 AAC；没有音轨时返回空数组 */
export function audioPassthroughArgs(media: MediaSummary): string[] {
  if (!media.audio) return [];
  return MP4_COPY_AUDIO.has(media.audio.codec) ? ['-c:a', 'copy'] : AAC_ENCODE;
}

export const MP4_OUTPUT = ['-movflags', '+faststart'];

/** 数字写进滤镜参数：最多 6 位小数，去掉多余的 0，避免出现 1e-7 这种滤镜表达式不认的写法 */
export function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`内部错误：非法的数值 ${n}`);
  return String(Number(n.toFixed(6)));
}

export interface VideoSource {
  file: string;
  media: MediaSummary;
  /**
   * 滤镜实际看到的画面尺寸：FFmpeg 默认按旋转元数据把画面摆正（autorotate），
   * 非方形像素由 prefilters 拉成方形像素，宽高都是偶数
   */
  width: number;
  height: number;
  /**
   * 取偶数之前的画面尺寸（摆正、换算方形像素之后）。奇数尺寸的源视频由 prefilters 切掉最后一行 / 列，
   * 坐标不变，这里比 width / height 多 1；用来校验用户给的坐标和在错误信息里报告真实尺寸
   */
  frameWidth: number;
  frameHeight: number;
  /** 数字帧率，异常时退回 30 */
  fps: number;
  /** 可以直接写进 fps 滤镜的帧率（如 30000/1001），来自 ffprobe 并已校验 */
  fpsExpr: string;
  /** 显示矩阵里的旋转角度（逆时针，度），没有时为 0 */
  rotation: number;
  /** 需要接在画面最前面的滤镜（非方形像素、奇数尺寸时才有） */
  prefilters: string[];
  /** 图片（png / jpg / 单帧）而不是视频 */
  isStill: boolean;
}

interface RawStream {
  codec_type?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string };
}

function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d{1,9})(?:[/:](\d{1,9}))?$/.exec(value.trim());
  if (!match) return 0;
  const num = Number(match[1]);
  const den = match[2] === undefined ? 1 : Number(match[2]);
  return den > 0 ? num / den : 0;
}

function pickFps(media: MediaSummary): { fps: number; fpsExpr: string } {
  for (const rate of [media.video?.frameRate, media.video?.avgFrameRate]) {
    const value = parseRational(rate);
    // mkv 的时间基有时被当成 r_frame_rate（1000/1），超过 120 的不可信
    if (value > 0 && value <= 120 && rate && /^\d{1,9}\/\d{1,9}$/.test(rate)) {
      return { fps: value, fpsExpr: rate };
    }
  }
  return { fps: 30, fpsExpr: '30' };
}

function readRotation(stream: RawStream | undefined): number {
  const matrix = stream?.side_data_list?.find((d) => d.side_data_type === 'Display Matrix');
  if (matrix && typeof matrix.rotation === 'number' && Number.isFinite(matrix.rotation)) {
    return matrix.rotation;
  }
  // 老文件把旋转写在 rotate 标签里（顺时针）
  const tag = Number(stream?.tags?.rotate);
  return Number.isFinite(tag) ? -tag : 0;
}

/**
 * 探测视频或图片输入。滤镜看到的是摆正后的画面，所以宽高、像素比都按旋转元数据换算；
 * 非方形像素（DV、部分监控录像）先拉成方形像素，后面所有尺寸计算都基于显示效果。
 * label 用在错误信息里，如「主视频」「第 2 个视频」
 */
export async function probeVideo(
  ctx: OperationContext,
  file: string,
  label: string,
): Promise<VideoSource> {
  let raw: RawProbe;
  try {
    raw = (await probeRaw(file, ctx.signal)) as RawProbe;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(`${label}无法解析: ${err instanceof Error ? err.message : String(err)}`);
  }
  const media = summarizeProbe(raw as Parameters<typeof summarizeProbe>[0]);
  const video = media.video;
  if (!video || video.width <= 0 || video.height <= 0) {
    throw new Error(`${label}不包含视频画面`);
  }
  const stream = raw.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const rotation = readRotation(stream);
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  let sar = parseRational(stream?.sample_aspect_ratio) || 1;
  let width = quarterTurn ? video.height : video.width;
  let height = quarterTurn ? video.width : video.height;
  if (quarterTurn) sar = 1 / sar;

  const prefilters: string[] = [];
  let frameWidth = width;
  let frameHeight = height;
  if (Math.abs(sar - 1) > 0.001) {
    // 和这里的数值计算保持一致：FFmpeg 表达式里的 sar 是摆正之后的像素比
    prefilters.push('scale=trunc(iw*sar/2)*2:trunc(ih/2)*2', 'setsar=1');
    width = evenFloor(Math.trunc(width * sar));
    height = evenFloor(height);
    // 整幅画面被拉伸到偶数尺寸，坐标就在拉伸后的画面上
    frameWidth = width;
    frameHeight = height;
  } else if (width % 2 !== 0 || height % 2 !== 0) {
    // 奇数宽高切掉最后一行 / 列，不重新缩放
    prefilters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0');
    width = evenFloor(width);
    height = evenFloor(height);
    frameWidth = Math.max(frameWidth, width);
    frameHeight = Math.max(frameHeight, height);
  }

  const formatName = raw.format?.format_name ?? '';
  const isStill =
    formatName === 'image2' ||
    formatName.endsWith('_pipe') ||
    stream?.nb_frames === '1' ||
    media.duration < 0.5;
  return {
    file,
    media,
    width,
    height,
    frameWidth,
    frameHeight,
    ...pickFps(media),
    rotation,
    prefilters,
    isStill,
  };
}

/** 视频输入还必须有时长，否则进度和 -t 都没法算 */
export function requireDuration(source: VideoSource, label: string): number {
  const duration = source.media.duration;
  if (!(duration > 0)) throw new Error(`${label}无法读取时长，可能不是视频文件`);
  return duration;
}

/**
 * 单输入、只改画面的操作：画面按 filters 重新编码，音轨能复制就复制，输出 mp4。
 * 只取第一路画面（V 不含封面图）和第一路音轨，字幕、数据流不带
 */
export async function encodeVideoFilter(
  ctx: OperationContext,
  source: VideoSource,
  filters: string[],
  extraOutputArgs: string[] = [],
): Promise<string> {
  const output = ctx.outputPath('mp4');
  await ctx.ffmpeg(
    [
      '-i',
      source.file,
      '-map',
      '0:V:0',
      '-map',
      '0:a:0?',
      '-vf',
      filters.join(','),
      ...VIDEO_ENCODE,
      ...audioPassthroughArgs(source.media),
      ...extraOutputArgs,
      ...MP4_OUTPUT,
      '-y',
      output,
    ],
    { duration: source.media.duration },
  );
  return output;
}

/** schema 里的「数字或数字字符串」统一到 enumParam，JSON 里传 90 和表单里传 "90" 都能识别 */
export function numericEnumParam<const T extends readonly [string, ...string[]]>(
  name: string,
  values: T,
) {
  return z.preprocess((v) => (typeof v === 'number' ? String(v) : v), enumParam(name, values));
}
