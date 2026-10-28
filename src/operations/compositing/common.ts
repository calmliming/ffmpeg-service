import fs from 'fs';
import { sizeParam } from '../../schemas/coerce';
import {
  probeRaw,
  type AudioStreamInfo,
  type MediaSummary,
  type VideoStreamInfo,
} from '../../utils/media-probe';
import type { OperationContext } from '../types';

/** 输出画面面积上限（8K） */
export const MAX_OUTPUT_PIXELS = 7680 * 4320;
/** 生成类操作（音频转视频、幻灯片）的输出时长上限 */
export const MAX_GENERATED_SECONDS = 4 * 3600;
/** 输入图片的像素上限：解码一张 1 亿像素的图就要 400 MB 内存 */
export const MAX_IMAGE_PIXELS = 100_000_000;

export const X264_ARGS = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-pix_fmt',
  'yuv420p',
];
export const AAC_ARGS = ['-c:a', 'aac', '-b:a', '192k'];

// libx264 + yuv420p 要求宽高都是偶数，奇数尺寸的素材重新编码前先裁掉 1 像素
export const EVEN_SCALE = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

// mp4 能直接装下的编码，其余（vp8、theora、pcm、vorbis…）流复制进 mp4 会失败，只能转码
const MP4_VIDEO_COPY = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);
const MP4_AUDIO_COPY = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac']);

export type Container = 'mp4' | 'mkv';

/**
 * 画面不需要滤镜时的编码参数：容器装得下就流复制，否则用默认 H.264 重新编码。
 * 重新编码时带上 -vf 偶数尺寸，调用方不能再对同一路输出用 -vf
 */
export function videoPassthroughArgs(video: VideoStreamInfo, container: Container): string[] {
  if (container === 'mkv' || MP4_VIDEO_COPY.has(video.codec)) {
    // HEVC 默认的 hev1 标签 Safari / QuickTime 不认
    return video.codec === 'hevc' && container === 'mp4'
      ? ['-c:v', 'copy', '-tag:v', 'hvc1']
      : ['-c:v', 'copy'];
  }
  const args = [...X264_ARGS];
  if (video.width % 2 || video.height % 2) args.push('-vf', EVEN_SCALE);
  return args;
}

/** 音频不需要滤镜时的编码参数：容器装得下就流复制，否则转 AAC */
export function audioPassthroughArgs(audio: AudioStreamInfo, container: Container): string[] {
  return container === 'mkv' || MP4_AUDIO_COPY.has(audio.codec) ? ['-c:a', 'copy'] : AAC_ARGS;
}

/** 写进滤镜参数的数字：最多 6 位小数、不用科学计数法。只用于校验过或自己算出来的数 */
export function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`内部错误：非法数值 ${n}`);
  const fixed = n.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

export function requireVideo(media: MediaSummary, label: string): VideoStreamInfo {
  if (!media.video || media.video.width <= 0 || media.video.height <= 0) {
    throw new Error(`${label}不包含视频画面`);
  }
  return media.video;
}

export function requireAudio(media: MediaSummary, label: string): AudioStreamInfo {
  if (!media.audio) throw new Error(`${label}不包含音频`);
  return media.audio;
}

export function assertOutputPixels(width: number, height: number, label: string): void {
  if (width * height > MAX_OUTPUT_PIXELS) {
    throw new Error(`${label}分辨率 ${width}x${height} 超过上限 7680x4320`);
  }
}

/** 探测失败时换成带输入名称的中文错误 */
export async function probeOrThrow(
  probe: (file: string) => Promise<MediaSummary>,
  file: string,
  label: string,
): Promise<MediaSummary> {
  try {
    return await probe(file);
  } catch (err) {
    throw new Error(`${label}无法解析: ${(err as Error).message}`);
  }
}

/**
 * 输出分辨率参数：宽x高，限制在 maxWidth x maxHeight 的面积内，奇数自动减 1 成偶数
 */
export function outputSizeParam(name: string, maxWidth: number, maxHeight: number) {
  const message = `${name} 不能超过 ${maxWidth}x${maxHeight}（总像素）`;
  return sizeParam(name)
    .refine((s) => s.width * s.height <= maxWidth * maxHeight, { error: message })
    .transform((s) => ({ width: s.width - (s.width % 2), height: s.height - (s.height % 2) }));
}

export type OutputSize = { width: number; height: number };

export interface StreamFacts {
  /** 字幕流数量（不含封面图之类的附件） */
  subtitleCount: number;
  /** 每条字幕流的编码名（ffprobe 的 codec_name，如 subrip、ass、mov_text），按 0:s:i 的顺序；未知编码为空串 */
  subtitleCodecs: string[];
  /** 第一路画面的旋转角度（手机竖拍视频常见 ±90），FFmpeg 解码时会自动转正 */
  rotation: number;
  /** 音频里内嵌的封面图（mp3 / m4a / flac 的 attached_pic）的流序号 */
  coverStreamIndex?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** probeMedia 里没有的流信息：旋转、字幕数量、内嵌封面 */
export async function probeStreamFacts(file: string, signal?: AbortSignal): Promise<StreamFacts> {
  const raw = await probeRaw(file, signal);
  const streams = Array.isArray(raw.streams) ? raw.streams.filter(isRecord) : [];
  const attached = (s: Record<string, unknown>) =>
    isRecord(s.disposition) && s.disposition.attached_pic === 1;
  const video = streams.find((s) => s.codec_type === 'video' && !attached(s));
  let rotation = 0;
  if (video) {
    const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
    const matrix = sideData.find((d) => isRecord(d) && typeof d.rotation === 'number');
    const tags = isRecord(video.tags) ? video.tags : {};
    rotation = isRecord(matrix) ? Number(matrix.rotation) : Number(tags.rotate ?? 0) || 0;
  }
  const cover = streams.find((s) => s.codec_type === 'video' && attached(s));
  const subtitleCodecs = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => (typeof s.codec_name === 'string' ? s.codec_name : ''));
  return {
    subtitleCount: subtitleCodecs.length,
    subtitleCodecs,
    rotation,
    coverStreamIndex: cover && typeof cover.index === 'number' ? cover.index : undefined,
  };
}

/** 自动转正后的画面尺寸：旋转 90 / 270 度时宽高互换 */
export function displaySize(video: VideoStreamInfo, rotation: number): OutputSize {
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return quarter
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
}

/** 混音统一用的采样率，循环用的 PCM 也按它解码，主命令里不用再转换 */
export const MIX_SAMPLE_RATE = 48000;
/** 解码出的音频比容器标注的时长多出这么多以内时，认为多出的是编码补齐的静音（AAC 一帧 1024 / 2048 个采样） */
const MAX_CODEC_PADDING = 0.1;

/**
 * 把要循环播放的音频解码成 PCM WAV（48 kHz 立体声 float）放进 workDir，返回路径，再交给 -stream_loop 循环。
 * 直接对压缩音频（AAC、MP3…）用 -stream_loop 时，FFmpeg 每一遍的时间偏移按数据包时长算，含编码延迟和补齐，
 * 比解码出的音频长 16-45 ms：接缝处留下时间戳空洞（混音时变成一小段静音），而且越循环越偏离画面。
 * PCM 每个包的时长就是采样数，循环严丝合缝。
 * mp4 / m4a 里的 AAC 解码后末尾还带着不到一帧的补齐静音（FFmpeg 不按编辑列表裁掉，实测 1 秒的 m4a 解码出 1.02 秒），
 * 所以解码结果比标注时长略长时再裁到标注时长，否则每一遍之间仍有约 20 ms 静音。
 * 标注时长是按码率估的（ADTS、无头 VBR MP3）、和解码结果差得多时不裁，以免裁掉真正的音乐
 */
export async function decodeLoopAudio(
  ctx: OperationContext,
  file: string,
  duration: number,
  range: [number, number],
): Promise<string> {
  const pcm = ['-ar', String(MIX_SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_f32le', '-rf64', 'auto'];
  const mid = (range[0] + range[1]) / 2;
  const full = ctx.tempPath('loop-full.wav');
  await ctx.ffmpeg(['-i', file, '-map', '0:a:0', ...pcm, '-y', full], {
    duration,
    range: [range[0], mid],
  });
  const excess = (await ctx.probe(full)).duration - duration;
  if (!(duration > 0) || excess * MIX_SAMPLE_RATE < 1 || excess > MAX_CODEC_PADDING) {
    ctx.progress(range[1]);
    return full;
  }
  const trimmed = ctx.tempPath('loop.wav');
  const samples = Math.round(duration * MIX_SAMPLE_RATE);
  await ctx.ffmpeg(['-i', full, '-af', `atrim=end_sample=${samples}`, ...pcm, '-y', trimmed], {
    duration,
    range: [mid, range[1]],
  });
  await fs.promises.rm(full, { force: true });
  return trimmed;
}

/** 按并发上限逐个处理，结果顺序与输入一致 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
