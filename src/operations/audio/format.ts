import fs from 'fs';
import { z } from 'zod';
import { blankToUndefined, enumParam, toNumber } from '../../schemas/coerce';
import {
  probeRaw,
  summarizeProbe,
  type AudioStreamInfo,
  type MediaSummary,
} from '../../utils/media-probe';
import type { OperationContext } from '../types';

// 音频组共用的输出格式、编码参数、输入探测和执行逻辑

export const AUDIO_FORMATS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** convert 的 sampleRate 可选值 */
export const SAMPLE_RATES: readonly number[] = [
  8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000,
];

/** 码率上下限（kbps），超过编码器自身上限时按编码器上限编码 */
export const MIN_KBPS = 8;
export const MAX_KBPS = 512;

interface FormatSpec {
  encoder: string;
  /** ffprobe 里的 codec_name，和输入相同时 convert 可以直接复制音频流 */
  codecName: string;
  muxer: string;
  lossless: boolean;
  /** 没指定 bitrate 时的编码参数 */
  defaultQuality: string[];
  /** 编码器接受的最高码率（kbps） */
  maxKbps?: number;
  /** 编码器支持的采样率，undefined 表示不限 */
  sampleRates?: readonly number[];
  extra: string[];
}

const AAC_RATES = [
  7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000,
];

const FORMATS: Record<AudioFormat, FormatSpec> = {
  mp3: {
    encoder: 'libmp3lame',
    codecName: 'mp3',
    muxer: 'mp3',
    lossless: false,
    defaultQuality: ['-b:a', '192k'],
    maxKbps: 320,
    sampleRates: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
    extra: [],
  },
  m4a: {
    encoder: 'aac',
    codecName: 'aac',
    muxer: 'ipod',
    lossless: false,
    defaultQuality: ['-b:a', '192k'],
    maxKbps: 512,
    sampleRates: AAC_RATES,
    // moov 放到文件头，浏览器拿到链接可以边下边播
    extra: ['-movflags', '+faststart'],
  },
  aac: {
    encoder: 'aac',
    codecName: 'aac',
    muxer: 'adts',
    lossless: false,
    defaultQuality: ['-b:a', '192k'],
    maxKbps: 512,
    sampleRates: AAC_RATES,
    extra: [],
  },
  wav: {
    encoder: 'pcm_s16le',
    codecName: 'pcm_s16le',
    muxer: 'wav',
    lossless: true,
    defaultQuality: [],
    extra: [],
  },
  flac: {
    encoder: 'flac',
    codecName: 'flac',
    muxer: 'flac',
    lossless: true,
    defaultQuality: [],
    extra: [],
  },
  ogg: {
    encoder: 'libvorbis',
    codecName: 'vorbis',
    muxer: 'ogg',
    lossless: false,
    // 约 192 kbps 的 VBR
    defaultQuality: ['-q:a', '6'],
    sampleRates: undefined,
    extra: [],
  },
  opus: {
    encoder: 'libopus',
    codecName: 'opus',
    muxer: 'opus',
    lossless: false,
    defaultQuality: ['-b:a', '128k'],
    maxKbps: 510,
    sampleRates: [8000, 12000, 16000, 24000, 48000],
    extra: [],
  },
};

export function formatSpec(format: AudioFormat): Readonly<FormatSpec> {
  return FORMATS[format];
}

// ---------- 参数 schema ----------

/**
 * 码率，输出 kbps 数字。接受 128k、0.32M、192000；纯数字不超过 1000 时按 kbps 理解（192 即 192k），
 * 因为几百 bps 的音频码率没有意义，客户端这样写几乎总是想要 kbps
 */
export function kbpsParam(name: string) {
  const message = `${name} 必须是 ${MIN_KBPS}k 到 ${MAX_KBPS}k 之间的码率，如 128k、192k 或 320000`;
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      if (v === undefined) return undefined;
      const text = typeof v === 'number' ? String(v) : v;
      if (typeof text !== 'string') return Number.NaN;
      const match = /^\s*(\d{1,9}(?:\.\d{1,3})?)\s*([kKmM]?)\s*$/.exec(text);
      if (!match) return Number.NaN;
      const n = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === 'k') return n;
      if (unit === 'm') return n * 1000;
      return n <= 1000 ? n : n / 1000;
    },
    z
      .number({ error: message })
      .min(MIN_KBPS, { error: message })
      .max(MAX_KBPS, { error: message }),
  );
}

export function sampleRateParam(name: string) {
  const message = `${name} 只能是 ${SAMPLE_RATES.join(' / ')} 之一`;
  return z.preprocess(
    toNumber,
    z.number({ error: message }).refine((v) => SAMPLE_RATES.includes(v), { error: message }),
  );
}

export const formatField = enumParam('format', AUDIO_FORMATS).optional().meta({
  description:
    '输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3',
});

export const bitrateField = kbpsParam('bitrate').optional().meta({
  description:
    '输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数',
});

/** 每个输出音频文件的操作都带的参数 */
export const outputFields = { format: formatField, bitrate: bitrateField };

/** 操作里引用的 afade / acrossfade 曲线名，校验后原样进滤镜 */
export const FADE_CURVES = [
  'tri',
  'qsin',
  'esin',
  'hsin',
  'log',
  'ipar',
  'qua',
  'cub',
  'squ',
  'cbr',
  'par',
  'exp',
  'iqsin',
  'ihsin',
  'dese',
  'desi',
  'losi',
  'sinc',
  'isinc',
  'quat',
  'quatr',
  'qsin2',
  'hsin2',
] as const;

export const FADE_CURVE_NOTE =
  'tri 线性、qsin 四分之一正弦、hsin 半正弦、esin 指数正弦、log 对数、exp 指数、par 抛物线、qua 二次、cub 三次、squ 平方根、cbr 立方根等，与 FFmpeg afade 的 curve 一致';

// ---------- 格式识别与兼容性 ----------

interface RawStream {
  codec_type?: unknown;
  codec_name?: unknown;
  disposition?: { attached_pic?: unknown };
}

/** 按 ffprobe 的容器名和音频编码判断输入属于哪种输出格式，不属于任何一种时返回 undefined */
export function formatFromProbe(raw: Record<string, unknown>): AudioFormat | undefined {
  const format = raw.format as { format_name?: unknown } | undefined;
  const name = typeof format?.format_name === 'string' ? format.format_name : '';
  const streams = Array.isArray(raw.streams) ? (raw.streams as RawStream[]) : [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const codec = typeof audio?.codec_name === 'string' ? audio.codec_name : '';
  // 封面图也是 video 流，不算画面
  const hasPicture = streams.some(
    (s) => s.codec_type === 'video' && !Number(s.disposition?.attached_pic),
  );
  const names = name.split(',');

  if (names.includes('mp3')) return 'mp3';
  if (names.includes('wav')) return 'wav';
  if (names.includes('flac')) return 'flac';
  if (names.includes('aac')) return 'aac';
  if (names.includes('ogg')) return codec === 'opus' ? 'opus' : 'ogg';
  if (names.includes('mov') || names.includes('mp4') || names.includes('m4a')) {
    if (!hasPicture && (codec === 'aac' || codec === 'alac')) return 'm4a';
  }
  return undefined;
}

/**
 * 第一条音轨自身的时长（秒），拿不到时返回 0。视频的音轨常比画面短或长一点，
 * 淡出起点、裁剪范围、变速后的时长都要按音轨算，不能用容器时长
 */
export function audioStreamDuration(raw: Record<string, unknown>): number {
  const streams = Array.isArray(raw.streams)
    ? (raw.streams as { codec_type?: unknown; duration?: unknown }[])
    : [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const seconds = typeof audio?.duration === 'string' ? parseFloat(audio.duration) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** 用户指定了格式就用它，否则沿用输入的格式（按内容识别），识别不出时用 mp3 */
export function outputFormat(media: AudioMedia, requested: AudioFormat | undefined): AudioFormat {
  return requested ?? media.detectedFormat ?? 'mp3';
}

/** 格式和采样率的组合是否可用，返回中文错误信息 */
export function sampleRateProblem(format: AudioFormat, sampleRate?: number): string | undefined {
  const rates = FORMATS[format].sampleRates;
  if (sampleRate === undefined || !rates || rates.includes(sampleRate)) return undefined;
  const allowed = SAMPLE_RATES.filter((r) => rates.includes(r)).join(' / ');
  return `${format} 格式不支持 ${sampleRate} Hz 采样率，可选 ${allowed}`;
}

/** 在格式支持的采样率里挑一个最接近 preferred 且不低于它的（没有就取最高），滤镜改了采样率之后用来还原 */
export function fitSampleRate(format: AudioFormat, preferred: number): number {
  const rates = FORMATS[format].sampleRates;
  const want = preferred > 0 ? preferred : 48000;
  if (!rates || rates.includes(want)) return want;
  return rates.find((r) => r >= want) ?? rates[rates.length - 1];
}

// libvorbis 的 ABR 在低采样率下给高码率会直接初始化失败，统一换算成 VBR 质量等级
const VORBIS_QUALITY: [number, number][] = [
  [45, -1],
  [64, 0],
  [80, 1],
  [96, 2],
  [112, 3],
  [128, 4],
  [160, 5],
  [192, 6],
  [224, 7],
  [256, 8],
  [320, 9],
  [500, 10],
];

export function vorbisQuality(kbps: number): number {
  let best = VORBIS_QUALITY[0];
  for (const entry of VORBIS_QUALITY) {
    if (Math.abs(entry[0] - kbps) < Math.abs(best[0] - kbps)) best = entry;
  }
  return best[1];
}

export interface EncodeOptions {
  format: AudioFormat;
  /** kbps */
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  /** 输入声道数，opus 的码率上限和声道数有关 */
  inputChannels?: number;
}

/** 输出音频的编码参数（-c:a、码率、采样率、声道、封装格式） */
export function encodeArgs(o: EncodeOptions): string[] {
  const spec = FORMATS[o.format];
  const args = ['-c:a', spec.encoder];
  if (!spec.lossless) {
    if (o.bitrate === undefined) {
      args.push(...spec.defaultQuality);
    } else if (o.format === 'ogg') {
      args.push('-q:a', String(vorbisQuality(o.bitrate)));
    } else {
      let max = spec.maxKbps ?? MAX_KBPS;
      // libopus 单声道最高 256 kbps，超过直接报错
      if (o.format === 'opus' && (o.channels ?? o.inputChannels ?? 2) === 1) max = 256;
      args.push('-b:a', `${Math.round(Math.min(o.bitrate, max))}k`);
    }
  }
  if (o.sampleRate) args.push('-ar', String(o.sampleRate));
  if (o.channels) args.push('-ac', String(o.channels));
  args.push(...spec.extra, '-f', spec.muxer);
  return args;
}

// ---------- 输入与执行 ----------

export type AudioMedia = MediaSummary & {
  audio: AudioStreamInfo;
  /** 第一条音轨的时长，拿不到时等于容器时长 duration */
  audioDuration: number;
  /** 按内容识别出的输出格式（不看扩展名），不是可输出的音频格式时为 undefined */
  detectedFormat?: AudioFormat;
  /** ffprobe 的完整输出，需要容器信息时用 */
  raw: Record<string, unknown>;
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 给 ffmpeg 的报错加上中文前缀。任务被取消时原样抛出，引擎据此区分取消和失败 */
export function rethrowWith(ctx: OperationContext, prefix: string) {
  return (err: unknown): never => {
    if (ctx.signal.aborted) throw err;
    throw new Error(`${prefix}: ${errorMessage(err)}`);
  };
}

/**
 * 探测输入并确认有音轨；label 用于错误信息，如「第 2 个文件」。
 * 只跑一次 ffprobe：摘要、音轨时长、格式识别都从同一份输出里取
 */
export async function probeAudio(
  ctx: OperationContext,
  file: string,
  label = '输入文件',
): Promise<AudioMedia> {
  const raw = await probeRaw(file, ctx.signal).catch((err: unknown) => {
    if (ctx.signal.aborted) throw err;
    throw new Error(`${label}无法解析，不是有效的音视频文件: ${errorMessage(err)}`);
  });
  const media = summarizeProbe(raw as Parameters<typeof summarizeProbe>[0]);
  if (!media.audio) throw new Error(`${label}没有音轨`);
  return {
    ...media,
    audio: media.audio,
    audioDuration: audioStreamDuration(raw) || media.duration,
    detectedFormat: formatFromProbe(raw),
    raw,
  };
}

export function singleInput(ctx: OperationContext, slot = 'file'): string {
  const file = ctx.inputs[slot]?.[0];
  if (!file) throw new Error(`缺少输入文件 ${slot}`);
  return file;
}

export interface SingleAudioInput {
  file: string;
  media: AudioMedia;
  format: AudioFormat;
}

/** 单文件音频操作的公共开头：探测输入、确定输出格式并检查采样率兼容 */
export async function prepareSingle(
  ctx: OperationContext,
  requested: AudioFormat | undefined,
  sampleRate?: number,
): Promise<SingleAudioInput> {
  const file = singleInput(ctx);
  const media = await probeAudio(ctx, file);
  const format = outputFormat(media, requested);
  const problem = sampleRateProblem(format, sampleRate);
  if (problem) throw new Error(problem);
  return { file, media, format };
}

/**
 * 把音轨的时间戳归零。音轨可能晚于文件开头才开始（MPEG-TS 录像、录屏、-itsoffset 混流的文件），
 * 解码出来的第一帧时间戳不是 0；afade 的 st、atrim 的 start / end、aselect 的 t 都按绝对时间戳工作，
 * 而操作的时间参数和 audioDuration 都是相对音轨自身开头的，不归零淡入会落在音轨开始之前、裁剪会少一截
 */
export const ZERO_PTS = 'asetpts=PTS-STARTPTS';

export interface AudioJob {
  inputs: readonly string[];
  /** 放在各个 -i 前面的输入参数（如 -ss / -t），下标与 inputs 对应 */
  inputOptions?: readonly (readonly string[] | undefined)[];
  /** -af 滤镜链，作用于第 1 个输入的第一条音轨；前面自动加上 ZERO_PTS，时间从音轨开头算起 */
  filter?: string;
  /** -filter_complex，输出标签必须是 [out]；给了它就忽略 filter。各输入链要自己归零时间戳（见 ZERO_PTS） */
  filterComplex?: string;
  encode: EncodeOptions;
  /** 预计输出时长（秒），用于进度 */
  duration?: number;
  range?: [number, number];
  /** 失败时错误信息的前缀 */
  errorPrefix: string;
  /** 需要解析滤镜打印的信息（如 loudnorm 的 JSON）时传入，命令会以 info 日志级别运行并回传完整 stderr */
  onStderr?: (stderr: string) => void;
}

/** 跑一条输出单个音频文件的 ffmpeg 命令，返回产物路径 */
export async function encodeAudio(ctx: OperationContext, job: AudioJob): Promise<string> {
  const output = ctx.outputPath(job.encode.format);
  const args: string[] = [];
  job.inputs.forEach((file, i) => args.push(...(job.inputOptions?.[i] ?? []), '-i', file));
  if (job.filterComplex) {
    args.push('-filter_complex', job.filterComplex, '-map', '[out]');
  } else {
    args.push('-map', '0:a:0', '-af', job.filter ? `${ZERO_PTS},${job.filter}` : ZERO_PTS);
  }
  args.push(...encodeArgs(job.encode), '-map_metadata', '0', '-y', output);
  const { stderr } = await ctx
    .ffmpeg(args, {
      duration: job.duration,
      range: job.range,
      ...(job.onStderr ? { logLevel: 'info' as const, captureStderr: true } : {}),
    })
    .catch(async (err: unknown) => {
      // 编码中途失败会留下半截文件；调用方可能换个方案重试（如 speed 退回 asetrate），残留文件不能留在产物目录
      await fs.promises.rm(output, { force: true }).catch(() => {});
      return rethrowWith(ctx, job.errorPrefix)(err);
    });
  job.onStderr?.(stderr);
  return output;
}

/** 数字拼进滤镜前统一格式化：最多保留 6 位小数，不出现科学计数法 */
export function num(value: number, digits = 6): string {
  const fixed = value.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
}

/** ffmpeg 最后一行统计里的 time=，即实际解码出来的时长；分析类命令用它代替可能不准的容器时长 */
export function decodedDuration(stderr: string): number | undefined {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = matches[matches.length - 1];
  if (!last) return undefined;
  const seconds = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** 同时跑若干个异步任务，最多 limit 个并发，保持结果顺序 */
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
