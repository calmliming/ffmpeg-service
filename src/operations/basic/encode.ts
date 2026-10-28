import { enumParam } from '../../schemas/coerce';
import type { AudioCodec, Container, VideoCodec } from './formats';

export const PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;
export type Preset = (typeof PRESETS)[number];
export const DEFAULT_PRESET: Preset = 'veryfast';

export const presetParam = (name: string) => enumParam(name, PRESETS);

/** CRF 的取值范围和默认值：x264 / x265 是 0-51，VP9 / AV1 是 0-63，VP8 最小 4 */
const CRF: Partial<Record<VideoCodec, { min: number; max: number; def: number }>> = {
  h264: { min: 0, max: 51, def: 23 },
  hevc: { min: 0, max: 51, def: 28 },
  vp9: { min: 0, max: 63, def: 31 },
  vp8: { min: 4, max: 63, def: 10 },
  av1: { min: 0, max: 63, def: 35 },
};

/** 没有 CRF 的编码器用固定质量（-q:v，越小越好） */
const QSCALE: Partial<Record<VideoCodec, number>> = {
  mpeg4: 3,
  mpeg2video: 3,
  mpeg1video: 3,
  theora: 7,
  wmv2: 3,
};

const ENCODER: Record<VideoCodec, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  vp8: 'libvpx',
  av1: 'libsvtav1',
  mpeg4: 'mpeg4',
  mpeg2video: 'mpeg2video',
  mpeg1video: 'mpeg1video',
  theora: 'libtheora',
  wmv2: 'wmv2',
};

const AUDIO_ENCODER: Record<AudioCodec, string> = {
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
  vorbis: 'libvorbis',
  flac: 'flac',
  alac: 'alac',
  ac3: 'ac3',
  mp2: 'mp2',
  pcm_s16le: 'pcm_s16le',
  pcm_s24le: 'pcm_s24le',
  wmav2: 'wmav2',
};

export const supportsCrf = (codec: VideoCodec) => CRF[codec] !== undefined;
/** 有速度档位的编码器：x264 / x265 原生支持，VP8 / VP9 / AV1 映射到各自的速度参数 */
export const supportsPreset = (codec: VideoCodec) => CRF[codec] !== undefined;

export function crfProblem(codec: VideoCodec, crf: number): string | undefined {
  const range = CRF[codec];
  if (!range) return `${codec} 编码不支持 crf，请改用 videoBitrate 控制质量`;
  if (crf < range.min || crf > range.max) {
    return `${codec} 编码的 crf 范围是 ${range.min}-${range.max}`;
  }
  return undefined;
}

// libvpx 的 good 模式 cpu-used 0-5，realtime 模式到 8；best 太慢，不用
const VPX_SPEED: Record<Preset, [deadline: string, cpuUsed: number]> = {
  ultrafast: ['realtime', 8],
  superfast: ['realtime', 7],
  veryfast: ['good', 4],
  faster: ['good', 4],
  fast: ['good', 3],
  medium: ['good', 2],
  slow: ['good', 1],
  slower: ['good', 1],
  veryslow: ['good', 0],
};

// SVT-AV1 的 preset 是 0（最慢）到 13（最快）
const SVT_PRESET: Record<Preset, number> = {
  ultrafast: 12,
  superfast: 11,
  veryfast: 10,
  faster: 9,
  fast: 8,
  medium: 7,
  slow: 5,
  slower: 4,
  veryslow: 3,
};

/** 不带单位时低于这个数按 kbps 理解 */
const BARE_KBPS_BELOW = 10000;

/**
 * 码率字符串（128k、2.5M、800000）换算成 bit/s。
 * 旧版经 fluent-ffmpeg 给不带单位的码率补 k（videoBitrate=1000 即 1000k），老客户端还在这样传；
 * 低于 10000 的裸数字按 kbps 理解，再大的按 bit/s（10 kbit/s 以下的音视频码率没有实际意义）
 */
export function parseBitrate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value.trim());
  if (!match) return Number.NaN;
  const unit = match[2].toLowerCase();
  const n = Number(match[1]);
  const scale = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : n < BARE_KBPS_BELOW ? 1e3 : 1;
  return Math.round(n * scale);
}

const VIDEO_BITRATE = { min: 10e3, max: 200e6 };

export function videoBitrateProblem(name: string, value: string): string | undefined {
  const bps = parseBitrate(value);
  if (!(bps >= VIDEO_BITRATE.min && bps <= VIDEO_BITRATE.max)) {
    return `${name} 必须在 10k 到 200M 之间`;
  }
  return undefined;
}

const AUDIO_BITRATE: Partial<Record<AudioCodec, { min: number; max: number }>> = {
  aac: { min: 8e3, max: 640e3 },
  mp3: { min: 8e3, max: 320e3 },
  opus: { min: 6e3, max: 512e3 },
  vorbis: { min: 32e3, max: 500e3 },
  ac3: { min: 32e3, max: 640e3 },
  mp2: { min: 32e3, max: 384e3 },
  // 更低的码率 wmav2 编码器不出包，FFmpeg 只说 Nothing was written into output file
  wmav2: { min: 32e3, max: 384e3 },
};

const fmtRate = (bps: number) => (bps % 1000 === 0 ? `${bps / 1000}k` : String(bps));

/** 无损编码（flac、alac、pcm）没有码率概念，返回 undefined 表示忽略 */
export function audioBitrateProblem(
  name: string,
  codec: AudioCodec,
  value: string,
): string | undefined {
  const range = AUDIO_BITRATE[codec];
  if (!range) return undefined;
  const bps = parseBitrate(value);
  if (!(bps >= range.min && bps <= range.max)) {
    return `${codec} 编码的 ${name} 必须在 ${fmtRate(range.min)} 到 ${fmtRate(range.max)} 之间`;
  }
  return undefined;
}

export const isLosslessAudio = (codec: AudioCodec) => AUDIO_BITRATE[codec] === undefined;

/** 重新编码时尽量沿用源码率（截到编码器范围内），源码率未知或无损编码返回 undefined 用默认值 */
export function matchSourceBitrate(codec: AudioCodec, sourceBps: number): string | undefined {
  const range = AUDIO_BITRATE[codec];
  if (!range || !(sourceBps > 0)) return undefined;
  const bps = Math.min(range.max, Math.max(range.min, Math.round(sourceBps / 1000) * 1000));
  return `${bps / 1000}k`;
}

/** 编码器只接受这些采样率，其余在入队前拒绝；没列出的编码（aac 以外的无损和 vorbis）接受 8000-192000 */
const SAMPLE_RATES: Partial<Record<AudioCodec, readonly number[]>> = {
  aac: [7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000],
  mp3: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
  opus: [8000, 12000, 16000, 24000, 48000],
  ac3: [32000, 44100, 48000],
  mp2: [16000, 22050, 24000, 32000, 44100, 48000],
  wmav2: [8000, 11025, 16000, 22050, 32000, 44100, 48000],
};

/**
 * 编码器不会自动转换的上限：wmav2 不声明支持的采样率和声道，源是 96 kHz 或 5.1 时 FFmpeg 直接打不开编码器。
 * 其余编码器声明了支持列表，FFmpeg 会自动重采样 / 下混
 */
const AUDIO_LIMITS: Partial<Record<AudioCodec, { sampleRate: number; channels: number }>> = {
  wmav2: { sampleRate: 48000, channels: 2 },
};

/** 没有指定采样率 / 声道时，源超出编码器上限就降到上限；返回值直接传给 audioEncoderArgs */
export function fitAudioLimits(
  codec: AudioCodec,
  source: { sampleRate: number; channels: number },
  requested: { sampleRate?: number; channels?: number },
): { sampleRate?: number; channels?: number } {
  const limit = AUDIO_LIMITS[codec];
  if (!limit) return requested;
  return {
    sampleRate:
      requested.sampleRate ?? (source.sampleRate > limit.sampleRate ? limit.sampleRate : undefined),
    channels: requested.channels ?? (source.channels > limit.channels ? limit.channels : undefined),
  };
}

export function sampleRateProblem(codec: AudioCodec, rate: number): string | undefined {
  const allowed = SAMPLE_RATES[codec];
  if (!allowed || allowed.includes(rate)) return undefined;
  return `${codec} 编码只支持采样率 ${allowed.join(' / ')}`;
}

// MPEG-1/2 视频只允许标准帧率，其它帧率 FFmpeg 直接报错
const MPEG_RATES: readonly [string, number][] = [
  ['24000/1001', 24000 / 1001],
  ['24', 24],
  ['25', 25],
  ['30000/1001', 30000 / 1001],
  ['30', 30],
  ['50', 50],
  ['60000/1001', 60000 / 1001],
  ['60', 60],
];

export const isMpegVideo = (codec: VideoCodec) => codec === 'mpeg2video' || codec === 'mpeg1video';

export function mpegFpsProblem(codec: VideoCodec, fps: number): string | undefined {
  if (!isMpegVideo(codec)) return undefined;
  if (MPEG_RATES.some(([, r]) => Math.abs(r - fps) < 0.01)) return undefined;
  return `${codec} 只支持帧率 23.976 / 24 / 25 / 29.97 / 30 / 50 / 59.94 / 60`;
}

/** 源帧率不是 MPEG 标准帧率时取最接近的标准值；已经是标准值返回 undefined（不用加 fps 滤镜） */
export function nearestMpegFps(fps: number): string | undefined {
  if (!(fps > 0)) return '25';
  if (MPEG_RATES.some(([, r]) => Math.abs(r - fps) < 0.01)) return undefined;
  let best = MPEG_RATES[0];
  for (const item of MPEG_RATES) {
    if (Math.abs(item[1] - fps) < Math.abs(best[1] - fps)) best = item;
  }
  return best[0];
}

/** ffprobe 的 "30000/1001" → 29.97 */
export function parseFrameRate(rate: string | undefined): number {
  const [num, den] = (rate ?? '').split('/').map(Number);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return den ? num / den : num;
}

export interface VideoEncodeOptions {
  codec: VideoCodec;
  container: Container;
  crf?: number;
  preset?: Preset;
  /** 已校验过的码率字符串 */
  bitrate?: string;
}

/**
 * 视频编码参数。只给码率是平均码率（ABR）；同时给 crf 和码率时码率作为上限（capped CRF）；
 * 都不给用各编码器的默认质量。AV1 单独给码率时 SVT-AV1 不按目标码率走（2026-10 实测超出 3 倍），统一用 capped CRF
 */
export function videoEncoderArgs(o: VideoEncodeOptions): string[] {
  const { codec } = o;
  const preset = o.preset ?? DEFAULT_PRESET;
  const bps = o.bitrate ? parseBitrate(o.bitrate) : undefined;
  const args = ['-c:v', ENCODER[codec]];
  const crf = CRF[codec];

  if (crf) {
    const quality = o.crf ?? (bps && codec !== 'av1' ? undefined : crf.def);
    switch (codec) {
      case 'h264':
      case 'hevc':
        args.push('-preset', preset);
        if (quality !== undefined) {
          args.push('-crf', String(quality));
          if (bps) args.push('-maxrate', String(bps), '-bufsize', String(bps * 2));
        } else if (bps) {
          args.push('-b:v', String(bps));
        }
        // x265 不管 -loglevel 都往 stderr 打 info 日志，失败时会把真正的错误挤出去
        if (codec === 'hevc') args.push('-x265-params', 'log-level=error');
        break;
      case 'vp9':
      case 'vp8': {
        const [deadline, cpuUsed] = VPX_SPEED[preset];
        args.push('-deadline', deadline, '-cpu-used', String(cpuUsed));
        if (codec === 'vp9') args.push('-row-mt', '1');
        if (quality !== undefined) args.push('-crf', String(quality));
        // VP9 的 -b:v 0 才是纯 CRF；VP8 的 CRF 必须配一个码率上限，不给时默认只有 256k
        const target = bps ?? (codec === 'vp9' ? 0 : 8e6);
        args.push('-b:v', String(target));
        break;
      }
      case 'av1':
        args.push('-preset', String(SVT_PRESET[preset]), '-crf', String(quality ?? crf.def));
        if (bps) args.push('-maxrate', String(bps));
        break;
      default:
        break;
    }
  } else if (bps) {
    args.push('-b:v', String(bps));
  } else {
    args.push('-q:v', String(QSCALE[codec] ?? 3));
  }

  // 10 bit / 4:4:4 源直接编码会得到浏览器和手机放不了的 High 10 / 4:4:4 档次
  args.push('-pix_fmt', 'yuv420p');
  // Apple 设备只认 hvc1 标签的 HEVC
  if (codec === 'hevc' && ['mp4', 'm4v', 'mov'].includes(o.container)) {
    args.push('-tag:v', 'hvc1');
  }
  return args;
}

export interface AudioEncodeOptions {
  codec: AudioCodec;
  bitrate?: string;
  sampleRate?: number;
  channels?: number;
}

const DEFAULT_AUDIO_BITRATE: Partial<Record<AudioCodec, string>> = {
  aac: '192k',
  mp3: '192k',
  opus: '128k',
  ac3: '192k',
  mp2: '192k',
  wmav2: '128k',
};

export function audioEncoderArgs(o: AudioEncodeOptions): string[] {
  const args = ['-c:a', AUDIO_ENCODER[o.codec]];
  if (!isLosslessAudio(o.codec)) {
    if (o.bitrate) args.push('-b:a', String(parseBitrate(o.bitrate)));
    else if (o.codec === 'vorbis') args.push('-q:a', '6');
    else args.push('-b:a', DEFAULT_AUDIO_BITRATE[o.codec] ?? '192k');
  }
  if (o.sampleRate) args.push('-ar', String(o.sampleRate));
  if (o.channels) args.push('-ac', String(o.channels));
  return args;
}

/** 容器级参数：封装器和 MP4 系列的 faststart */
export function muxerArgs(spec: { muxer: string; faststart?: boolean }): string[] {
  const args: string[] = [];
  if (spec.faststart) args.push('-movflags', '+faststart');
  args.push('-f', spec.muxer);
  return args;
}
