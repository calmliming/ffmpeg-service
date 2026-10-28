import { probeRaw, type MediaSummary } from '../../utils/media-probe';
import type { OperationContext } from '../types';

/** 输出画面上限 8K */
export const MAX_WIDTH = 7680;
export const MAX_HEIGHT = 4320;
export const MAX_FPS = 120;

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
export const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '192k'];
// moov 放到文件头，浏览器拿到下载地址可以边下边播
export const FASTSTART = ['-movflags', '+faststart'];

// 能原样放进 MP4 的编码。vorbis、pcm 之类流复制进 MP4 会直接失败，遇到时只能重新编码
const MP4_VIDEO_CODECS = new Set(['h264', 'hevc', 'av1', 'mpeg4']);
const MP4_AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

/** 拼进 FFmpeg 参数的数字：最多 6 位小数，不会出现科学计数法 */
export function num(value: number, digits = 6): string {
  return String(Number(value.toFixed(digits)));
}

/** 时间统一保留到毫秒 */
export function sec(value: number): string {
  return num(value, 3);
}

/** 文案里的秒数，如 12.35 */
export function fmtSec(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 探测输入并做基本检查：必须有音视频流、时长可知、画面不超过 8K */
export async function probeInput(
  ctx: OperationContext,
  file: string,
  label = '输入文件',
): Promise<MediaSummary> {
  const media = await ctx.probe(file).catch((err: Error) => {
    if (ctx.signal.aborted) throw err;
    throw new Error(`${label}无法解析: ${err.message}`);
  });
  if (!media.video && !media.audio) throw new Error(`${label}不包含音频或视频流`);
  if (!(media.duration > 0)) throw new Error(`${label}无法获取时长，可能已损坏`);
  const v = media.video;
  if (
    v &&
    (v.width > MAX_WIDTH || v.height > MAX_HEIGHT) &&
    (v.width > MAX_HEIGHT || v.height > MAX_WIDTH)
  ) {
    throw new Error(`${label}分辨率 ${v.width}x${v.height} 超过上限 ${MAX_WIDTH}x${MAX_HEIGHT}`);
  }
  return media;
}

/** 画面的有效时长：有画面时按画面流，否则按整个文件 */
export function mainDuration(media: MediaSummary): number {
  return media.video?.duration || media.duration;
}

export function parseRate(rate: string): number {
  const [n, d] = rate.split('/').map(Number);
  if (!Number.isFinite(n)) return 0;
  return d ? n / d : n;
}

/**
 * 源帧率，异常时退回 30。VFR 的 mkv / webm 的 r_frame_rate 常是 1000/1，这时用平均帧率
 */
export function sourceFps(media: MediaSummary): number {
  const v = media.video;
  if (!v) return 30;
  for (const rate of [v.frameRate, v.avgFrameRate]) {
    const value = parseRate(rate);
    if (value > 0 && value <= 240) return value;
  }
  return 30;
}

/** 输出帧率：源帧率封顶 120 */
export function outputFps(media: MediaSummary): number {
  return Math.min(sourceFps(media), MAX_FPS);
}

/** libx264 + yuv420p 要求宽高都是偶数，奇数尺寸的素材补一个缩放，否则编码器直接报错 */
export function evenSizeFilters(media: MediaSummary): string[] {
  const v = media.video;
  if (!v || (v.width % 2 === 0 && v.height % 2 === 0)) return [];
  return ['scale=trunc(iw/2)*2:trunc(ih/2)*2'];
}

/** 有画面的输出用 mp4，纯音频输出用 m4a（AAC） */
export function reencodeExt(media: MediaSummary): 'mp4' | 'm4a' {
  return media.video ? 'mp4' : 'm4a';
}

/** 画面不经过滤镜时尽量流复制；编码放不进 MP4 时才重新编码 */
export function copyVideoArgs(media: MediaSummary): string[] {
  const codec = media.video?.codec ?? '';
  if (!MP4_VIDEO_CODECS.has(codec)) {
    const filters = evenSizeFilters(media);
    return filters.length > 0 ? ['-vf', filters.join(','), ...VIDEO_ENCODE] : VIDEO_ENCODE;
  }
  // 苹果设备只认 hvc1 标签的 HEVC
  return codec === 'hevc' ? ['-c:v', 'copy', '-tag:v', 'hvc1'] : ['-c:v', 'copy'];
}

/** 音频不经过滤镜时尽量流复制；编码放不进 MP4 / M4A 时才重新编码 */
export function copyAudioArgs(media: MediaSummary): string[] {
  return MP4_AUDIO_CODECS.has(media.audio?.codec ?? '') ? ['-c:a', 'copy'] : AUDIO_ENCODE;
}

export interface CopyContainer {
  /** 产物扩展名，固定白名单 */
  ext: string;
  /** FFmpeg 封装格式名，segment 封装器需要 */
  format: string;
  /** 额外的流参数，如 HEVC 的 hvc1 标签 */
  extraArgs: string[];
  movflags: boolean;
}

/** 整体流复制时按编码选容器：MP4 放得下就用 MP4 / M4A，否则退回 MKV / MKA 等通用容器 */
export function copyContainer(media: MediaSummary): CopyContainer {
  const vcodec = media.video?.codec;
  const acodec = media.audio?.codec;
  if (vcodec) {
    const mp4 = MP4_VIDEO_CODECS.has(vcodec) && (!acodec || MP4_AUDIO_CODECS.has(acodec));
    if (!mp4) return { ext: 'mkv', format: 'matroska', extraArgs: [], movflags: false };
    const extraArgs = vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
    return { ext: 'mp4', format: 'mp4', extraArgs, movflags: true };
  }
  switch (acodec) {
    case 'aac':
    case 'alac':
      return { ext: 'm4a', format: 'ipod', extraArgs: [], movflags: true };
    case 'mp3':
      return { ext: 'mp3', format: 'mp3', extraArgs: [], movflags: false };
    case 'flac':
      return { ext: 'flac', format: 'flac', extraArgs: [], movflags: false };
    case 'opus':
      return { ext: 'opus', format: 'opus', extraArgs: [], movflags: false };
    case 'vorbis':
      return { ext: 'ogg', format: 'ogg', extraArgs: [], movflags: false };
    default:
      return { ext: 'mka', format: 'matroska', extraArgs: [], movflags: false };
  }
}

/** 只取第一路画面（跳过封面图）和第一路音轨，字幕、数据流不保留 */
export function streamMaps(media: MediaSummary): string[] {
  const maps: string[] = [];
  if (media.video) maps.push('-map', '0:V:0');
  if (media.audio) maps.push('-map', '0:a:0');
  return maps;
}

/**
 * 音轨自身的时长。MediaSummary 只有整个文件的时长，画面比声音长时按文件时长算淡出会落在音轨结束之后
 */
export async function audioStreamDuration(
  ctx: OperationContext,
  file: string,
  media: MediaSummary,
): Promise<number> {
  const raw = await probeRaw(file, ctx.signal).catch(() => undefined);
  const streams = (raw?.streams ?? []) as { codec_type?: string; duration?: string }[];
  const audio = streams.find((s) => s.codec_type === 'audio');
  return parseFloat(audio?.duration ?? '') || media.duration;
}

/** ffconcat 列表，文件都在 workDir 里时只写文件名，避免 Windows 路径的转义问题 */
export function bareConcatList(names: string[]): string {
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`非法的中间文件名: ${name}`);
  }
  return ['ffconcat version 1.0', ...names.map((name) => `file '${name}'`)].join('\n') + '\n';
}

/** atempo 单级超过 2 倍会跳帧发虚、低于 0.5 不被支持，拆成多级串联 */
export function atempoChain(factor: number): string[] {
  const steps: string[] = [];
  let rest = factor;
  while (rest > 2 + 1e-9) {
    steps.push('atempo=2');
    rest /= 2;
  }
  while (rest < 0.5 - 1e-9) {
    steps.push('atempo=0.5');
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 1e-9 || steps.length === 0) steps.push(`atempo=${num(rest)}`);
  return steps;
}
