import { z } from 'zod';
import { blankToUndefined } from '../../schemas/coerce';

export const VIDEO_CONTAINERS = [
  'mp4',
  'mkv',
  'mov',
  'webm',
  'avi',
  'flv',
  'ts',
  'm4v',
  '3gp',
  'ogv',
  'mpg',
  'wmv',
] as const;
export const AUDIO_CONTAINERS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] as const;
export type VideoContainer = (typeof VIDEO_CONTAINERS)[number];
export type AudioContainer = (typeof AUDIO_CONTAINERS)[number];
export type Container = VideoContainer | AudioContainer;

// 内部编码名与 ffprobe 的 codec_name 一致，这样「源编码能否直接复制」可以直接查表
export const VIDEO_CODECS = [
  'h264',
  'hevc',
  'vp9',
  'vp8',
  'av1',
  'mpeg4',
  'mpeg2video',
  'mpeg1video',
  'theora',
  'wmv2',
] as const;
export const AUDIO_CODECS = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
  'alac',
  'ac3',
  'mp2',
  'pcm_s16le',
  'pcm_s24le',
  'wmav2',
] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];
export type AudioCodec = (typeof AUDIO_CODECS)[number];

export interface ContainerSpec {
  /** ffmpeg -f 的封装器名 */
  muxer: string;
  /** 允许的视频编码；纯音频格式没有 */
  video?: readonly VideoCodec[];
  audio: readonly AudioCodec[];
  defaultVideo?: VideoCodec;
  defaultAudio: AudioCodec;
  /** MP4 系列：moov 前置，浏览器可以边下边播 */
  faststart?: boolean;
}

const ALL_VIDEO = VIDEO_CODECS;
const ALL_AUDIO = AUDIO_CODECS;
const MP4_VIDEO: readonly VideoCodec[] = ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'];
const MP4_AUDIO: readonly AudioCodec[] = ['aac', 'mp3', 'opus', 'flac', 'alac', 'ac3'];

/**
 * 每种容器允许的编码组合。FFmpeg 的封装器能写进去的组合远比这多（avi、ts、mpg 几乎什么都收），
 * 这里只放主流播放器能正常播放的组合，其余在入队前就以 400 拒绝，免得用户拿到放不出来的文件
 */
export const CONTAINERS: Record<Container, ContainerSpec> = {
  mp4: {
    muxer: 'mp4',
    video: MP4_VIDEO,
    audio: MP4_AUDIO,
    defaultVideo: 'h264',
    defaultAudio: 'aac',
    faststart: true,
  },
  m4v: {
    muxer: 'mp4',
    video: ['h264', 'hevc', 'mpeg4'],
    audio: ['aac', 'alac', 'ac3'],
    defaultVideo: 'h264',
    defaultAudio: 'aac',
    faststart: true,
  },
  mov: {
    muxer: 'mov',
    video: ['h264', 'hevc', 'mpeg4'],
    audio: ['aac', 'mp3', 'alac', 'ac3', 'pcm_s16le', 'pcm_s24le'],
    defaultVideo: 'h264',
    defaultAudio: 'aac',
    faststart: true,
  },
  '3gp': {
    muxer: '3gp',
    video: ['h264', 'mpeg4'],
    audio: ['aac'],
    defaultVideo: 'h264',
    defaultAudio: 'aac',
    faststart: true,
  },
  mkv: {
    muxer: 'matroska',
    video: ALL_VIDEO,
    audio: ALL_AUDIO,
    defaultVideo: 'h264',
    defaultAudio: 'aac',
  },
  webm: {
    muxer: 'webm',
    video: ['vp9', 'vp8', 'av1'],
    audio: ['opus', 'vorbis'],
    defaultVideo: 'vp9',
    defaultAudio: 'opus',
  },
  avi: {
    muxer: 'avi',
    video: ['h264', 'mpeg4'],
    audio: ['mp3', 'aac', 'ac3', 'mp2', 'pcm_s16le'],
    defaultVideo: 'h264',
    defaultAudio: 'mp3',
  },
  flv: {
    muxer: 'flv',
    video: ['h264'],
    audio: ['aac', 'mp3'],
    defaultVideo: 'h264',
    defaultAudio: 'aac',
  },
  ts: {
    muxer: 'mpegts',
    video: ['h264', 'hevc', 'mpeg2video'],
    audio: ['aac', 'mp3', 'mp2', 'ac3', 'opus'],
    defaultVideo: 'h264',
    defaultAudio: 'aac',
  },
  ogv: {
    muxer: 'ogg',
    video: ['theora', 'vp8'],
    audio: ['vorbis', 'opus', 'flac'],
    defaultVideo: 'theora',
    defaultAudio: 'vorbis',
  },
  mpg: {
    muxer: 'mpeg',
    video: ['mpeg2video', 'mpeg1video'],
    audio: ['mp2', 'mp3', 'ac3'],
    defaultVideo: 'mpeg2video',
    defaultAudio: 'mp2',
  },
  // 旧版把 format 直接当扩展名，wmv 输出 ASF；用 WMV8（wmv2）+ WMA2，Windows 自带播放器都能放
  wmv: {
    muxer: 'asf',
    video: ['wmv2'],
    audio: ['wmav2'],
    defaultVideo: 'wmv2',
    defaultAudio: 'wmav2',
  },
  mp3: { muxer: 'mp3', audio: ['mp3'], defaultAudio: 'mp3' },
  m4a: { muxer: 'ipod', audio: ['aac', 'alac'], defaultAudio: 'aac', faststart: true },
  aac: { muxer: 'adts', audio: ['aac'], defaultAudio: 'aac' },
  wav: { muxer: 'wav', audio: ['pcm_s16le', 'pcm_s24le'], defaultAudio: 'pcm_s16le' },
  flac: { muxer: 'flac', audio: ['flac'], defaultAudio: 'flac' },
  ogg: { muxer: 'ogg', audio: ['vorbis', 'opus', 'flac'], defaultAudio: 'vorbis' },
  opus: { muxer: 'opus', audio: ['opus'], defaultAudio: 'opus' },
};

export const isAudioContainer = (c: Container): c is AudioContainer =>
  (AUDIO_CONTAINERS as readonly string[]).includes(c);

export const isVideoCodec = (name: string | undefined): name is VideoCodec =>
  (VIDEO_CODECS as readonly string[]).includes(name ?? '');

export const isAudioCodec = (name: string | undefined): name is AudioCodec =>
  (AUDIO_CODECS as readonly string[]).includes(name ?? '');

/**
 * 输入有画面时实际套用的容器规则。旧版直接按扩展名输出，format=ogg 的视频得到 theora + vorbis 的 Ogg 视频，
 * 所以 ogg 遇到有画面的输入按 ogv 的编码规则处理（扩展名仍是 .ogg）；其余格式原样返回
 */
export const videoVariant = (c: Container): Container => (c === 'ogg' ? 'ogv' : c);

/** 输出文件扩展名：容器名本身就是白名单里的扩展名 */
export const extensionOf = (c: Container): string => c;

const FORMAT_ALIASES: Record<string, Container> = {
  mpeg: 'mpg',
  matroska: 'mkv',
  quicktime: 'mov',
  qt: 'mov',
  mpegts: 'ts',
  '3gpp': '3gp',
  oga: 'ogg',
  wave: 'wav',
  asf: 'wmv',
};

const VIDEO_CODEC_ALIASES: Record<string, VideoCodec | 'copy'> = {
  h264: 'h264',
  'h.264': 'h264',
  avc: 'h264',
  x264: 'h264',
  libx264: 'h264',
  h265: 'hevc',
  'h.265': 'hevc',
  hevc: 'hevc',
  x265: 'hevc',
  libx265: 'hevc',
  vp9: 'vp9',
  'libvpx-vp9': 'vp9',
  vp8: 'vp8',
  libvpx: 'vp8',
  av1: 'av1',
  libsvtav1: 'av1',
  svtav1: 'av1',
  'svt-av1': 'av1',
  mpeg4: 'mpeg4',
  mpeg2: 'mpeg2video',
  mpeg2video: 'mpeg2video',
  mpeg1: 'mpeg1video',
  mpeg1video: 'mpeg1video',
  theora: 'theora',
  libtheora: 'theora',
  wmv2: 'wmv2',
  wmv8: 'wmv2',
  copy: 'copy',
};

const AUDIO_CODEC_ALIASES: Record<string, AudioCodec | 'copy'> = {
  aac: 'aac',
  mp3: 'mp3',
  libmp3lame: 'mp3',
  opus: 'opus',
  libopus: 'opus',
  vorbis: 'vorbis',
  libvorbis: 'vorbis',
  flac: 'flac',
  alac: 'alac',
  ac3: 'ac3',
  mp2: 'mp2',
  pcm: 'pcm_s16le',
  pcm_s16le: 'pcm_s16le',
  pcm_s24le: 'pcm_s24le',
  wmav2: 'wmav2',
  copy: 'copy',
};

/** 用户可见的编码名（报错和文档用），与 FFmpeg 编码器的对应关系 */
export const VIDEO_CODEC_LABELS: Record<VideoCodec, string> = {
  h264: 'h264（libx264）',
  hevc: 'h265 / hevc（libx265）',
  vp9: 'vp9（libvpx-vp9）',
  vp8: 'vp8（libvpx）',
  av1: 'av1（libsvtav1）',
  mpeg4: 'mpeg4',
  mpeg2video: 'mpeg2video',
  mpeg1video: 'mpeg1video',
  theora: 'theora（libtheora）',
  wmv2: 'wmv2（WMV8）',
};

const lower = (value: unknown) => {
  const v = blankToUndefined(value);
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
};

/**
 * 输出格式参数：忽略大小写和开头的点，接受常见别名（mpeg→mpg、matroska→mkv…）。
 * redirect 给特定的不支持值加一句指引（如 gif → 请用 /api/process/gif）
 */
export function formatParam<const T extends readonly [Container, ...Container[]]>(
  name: string,
  allowed: T,
  hint = allowed.join(' / '),
  redirect: Readonly<Record<string, string>> = {},
) {
  const message = `${name} 只能是 ${hint}`;
  return z.preprocess(
    (value) => {
      const v = lower(value);
      if (typeof v !== 'string') return v;
      const bare = v.replace(/^\./, '');
      return FORMAT_ALIASES[bare] ?? bare;
    },
    z.enum(allowed, {
      error: (issue) => {
        const extra = typeof issue.input === 'string' ? redirect[issue.input] : undefined;
        return extra ? `${message}；${extra}` : message;
      },
    }),
  );
}

export function videoCodecParam(name: string) {
  const values = [...VIDEO_CODECS, 'copy'] as const;
  const hint =
    'h264、h265（hevc）、vp9、vp8、av1、mpeg4、mpeg2video、mpeg1video、theora、wmv2、copy';
  return z.preprocess(
    (value) => {
      const v = lower(value);
      return typeof v === 'string' ? (VIDEO_CODEC_ALIASES[v] ?? v) : v;
    },
    z.enum(values, { error: `${name} 只能是 ${hint}（也接受 libx264 这类 FFmpeg 编码器名）` }),
  );
}

export function audioCodecParam(name: string) {
  const values = [...AUDIO_CODECS, 'copy'] as const;
  const hint = 'aac、mp3、opus、vorbis、flac、alac、ac3、mp2、pcm_s16le、pcm_s24le、wmav2、copy';
  return z.preprocess(
    (value) => {
      const v = lower(value);
      return typeof v === 'string' ? (AUDIO_CODEC_ALIASES[v] ?? v) : v;
    },
    z.enum(values, { error: `${name} 只能是 ${hint}（也接受 libmp3lame 这类 FFmpeg 编码器名）` }),
  );
}

/** 「mp4 不支持 vp8 视频编码，可选 h264 / hevc …」。label 是报错里显示的格式名（ogg 按 ogv 的规则检查时仍显示 ogg） */
export function videoCodecProblem(
  container: Container,
  codec: VideoCodec,
  label: string = container,
): string | undefined {
  const allowed = CONTAINERS[container].video;
  if (!allowed) return `${label} 是纯音频格式，不能设置视频编码`;
  if (allowed.includes(codec)) return undefined;
  return `${label} 不支持 ${codec} 视频编码，可选 ${allowed.join(' / ')}`;
}

export function audioCodecProblem(container: Container, codec: AudioCodec): string | undefined {
  const allowed = CONTAINERS[container].audio;
  if (allowed.includes(codec)) return undefined;
  return `${container} 不支持 ${codec} 音频编码，可选 ${allowed.join(' / ')}`;
}
