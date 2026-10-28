import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { blankToUndefined, enumParam, numberParam } from '../../schemas/coerce';
import { probeRaw, summarizeProbe, type AudioStreamInfo } from '../../utils/media-probe';
import type { OperationContext } from '../types';

/** 输出分辨率上限（8K），缩略图、雪碧图、水印图片的尺寸都受它约束 */
export const MAX_WIDTH = 7680;
export const MAX_HEIGHT = 4320;
export const MAX_PIXELS = MAX_WIDTH * MAX_HEIGHT;

export const IMAGE_FORMATS = ['png', 'jpg', 'webp'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export function imageFormatParam(defaultFormat: ImageFormat) {
  return enumParam('format', IMAGE_FORMATS)
    .default(defaultFormat)
    .meta({ description: `图片格式：png（无损）、jpg、webp，默认 ${defaultFormat}` });
}

export function qualityParam(defaultQuality: number) {
  return numberParam('quality', { min: 1, max: 100, int: true })
    .default(defaultQuality)
    .meta({
      description: `图片质量 1-100，越大越清晰、文件越大，默认 ${defaultQuality}；只对 jpg 和 webp 生效`,
    });
}

export function widthParam(description: string) {
  return numberParam('width', { min: 16, max: MAX_WIDTH, int: true })
    .optional()
    .meta({ description });
}

/** 图片编码参数。jpg 的 -q:v 是 1（最好）到 31（最差），把 1-100 的质量线性映射过去 */
export function imageEncodeArgs(format: ImageFormat, quality: number): string[] {
  if (format === 'jpg') {
    const q = Math.round(1 + ((100 - quality) * 30) / 99);
    return ['-c:v', 'mjpeg', '-q:v', String(Math.min(31, Math.max(1, q)))];
  }
  if (format === 'webp') return ['-c:v', 'libwebp', '-quality', String(quality)];
  return ['-c:v', 'png'];
}

/**
 * 写单张图片。统一走 image2 muxer + -update 1：不加 -update 时文件名没有 %d 会打警告，
 * .webp 扩展名默认会选到动图 webp muxer
 */
export function singleImageOutput(format: ImageFormat, quality: number, out: string): string[] {
  return [
    '-frames:v',
    '1',
    ...imageEncodeArgs(format, quality),
    '-f',
    'image2',
    '-update',
    '1',
    '-y',
    out,
  ];
}

export interface VideoInfo {
  /** 整个文件的时长，音轨更长时比画面长 */
  duration: number;
  /** 画面时长，截图、抽帧以它为准 */
  videoDuration: number;
  /** 显示尺寸：已按旋转和像素宽高比换算，计算缩略图比例要用它 */
  width: number;
  height: number;
  /** 帧率，取不到时按 25 */
  fps: number;
  /** 像素宽高比，非 1 时（变形宽银幕）截图前要先拉正 */
  sar: number;
  /** 容器有关键帧索引（mp4 / mov / mkv / webm），-ss 放在 -i 前面能准确跳转，见 seekPlans */
  fastSeek: boolean;
  audio?: AudioStreamInfo;
}

/** format_name 里出现这些名字时按有索引处理；其余容器（MPEG-TS、MPEG-PS、裸流等）走带校验的定位 */
const FAST_SEEK_FORMATS = new Set(['mov', 'mp4', 'matroska', 'webm']);

interface RawStream {
  codec_type?: string;
  sample_aspect_ratio?: string;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
  disposition?: { attached_pic?: number };
}

function parseRatio(value: string | undefined, separator: string): number {
  if (!value) return 0;
  const [num, den] = value.split(separator).map(Number);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (den === undefined) return num;
  return Number.isFinite(den) && den > 0 ? num / den : 0;
}

/**
 * 探测视频画面。输入可能是上传或 URL 下载的任意扩展名文件，一律以 ffprobe 的结果为准；
 * 没有画面（纯音频）时直接报错
 */
export async function probeVideo(
  ctx: OperationContext,
  file: string,
  label = '输入文件',
): Promise<VideoInfo> {
  const raw = await probeRaw(file, ctx.signal).catch((err: unknown) => {
    if (ctx.signal.aborted) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}无法解析: ${detail}`);
  });
  const summary = summarizeProbe(raw as Parameters<typeof summarizeProbe>[0]);
  const v = summary.video;
  if (!v || v.width <= 0 || v.height <= 0) throw new Error(`${label}不包含视频画面`);

  const streams = (raw.streams ?? []) as RawStream[];
  const stream = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const sar = parseRatio(stream?.sample_aspect_ratio, ':') || 1;
  const rotation =
    stream?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ??
    Number(stream?.tags?.rotate ?? 0);
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const displayWidth = Math.max(1, Math.round(v.width * sar));
  const rate = parseRatio(v.avgFrameRate, '/') || parseRatio(v.frameRate, '/');
  const fps = rate > 0 && rate <= 1000 ? rate : 25;
  const format = (raw.format as { format_name?: string } | undefined)?.format_name ?? '';

  return {
    duration: summary.duration,
    // 单张图片当视频传进来时没有时长，按一帧算
    videoDuration: v.duration || summary.duration || 1 / fps,
    width: quarterTurn ? v.height : displayWidth,
    height: quarterTurn ? displayWidth : v.height,
    fps,
    sar,
    fastSeek: format.split(',').some((name) => FAST_SEEK_FORMATS.has(name.trim())),
    audio: summary.audio,
  };
}

/** 像素不是正方形时先按显示比例拉正，否则按宽度等比缩放会变形 */
export function squarePixelFilters(info: VideoInfo): string[] {
  return Math.abs(info.sar - 1) > 0.001 ? ['scale=iw*sar:ih', 'setsar=1'] : [];
}

/**
 * 输出尺寸上限：每边不超过 7680，总像素不超过 7680x4320（竖屏 4320x7680 也允许）。
 * 只给宽度时高度由画面比例决定，参数校验阶段算不出来，只能探测后在这里拦
 */
export function assertOutputSize(width: number, height: number, label: string): void {
  if (width > MAX_WIDTH || height > MAX_WIDTH || width * height > MAX_PIXELS) {
    throw new Error(
      `${label} ${width}x${height} 超过上限：每边不超过 ${MAX_WIDTH} 像素，总像素不超过 ${MAX_WIDTH}x${MAX_HEIGHT}`,
    );
  }
}

/** 截图滤镜：先拉正像素，再按 width 等比缩放（不传 width 时保持原尺寸） */
export function widthFilters(info: VideoInfo, width: number | undefined): string[] {
  const filters = squarePixelFilters(info);
  if (width === undefined) return filters;
  const height = Math.max(1, Math.round((width * info.height) / info.width));
  assertOutputSize(width, height, `按 width=${width} 等比缩放后图片尺寸为`);
  return [...filters, `scale=${width}:-1`];
}

/** 最后一帧的时间点：-ss 精确定位会丢掉早于该时间的帧，定位到时长本身就一帧都取不到 */
export function lastFrameTime(info: VideoInfo): number {
  return Math.max(0, info.videoDuration - 1 / info.fps - 0.001);
}

/** 时间拼进 ffmpeg 参数前统一成三位小数 */
export function seconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}

/** 报错信息里的时间：去掉多余的 0 */
export function formatSeconds(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** 把 workDir 里生成的文件移到输出目录。两者可能不在同一个卷上（Docker 挂载），rename 不行时复制后删除 */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.copyFile(from, to);
    await fs.promises.rm(from, { force: true });
  }
}

/** 时间比较的容差：时间戳换算（90kHz、三位小数）会差零点几毫秒，正好落在帧上的目标不能因此错过这一帧 */
const TIME_EPSILON = 0.0005;

/**
 * 没有索引的容器先跳到目标前这么多秒再解码。MPEG-TS 等的 -ss 会落到非关键帧上，解码器丢掉直到下一个关键帧的画面，
 * 跳到目标前一个 GOP 以上才能从目标之前的关键帧开始解码。常见 GOP 在 10 秒以内，不够时换 60 秒，最后从头解码
 */
const SEEK_MARGINS = [10, 60];

/** 一次定位尝试 */
export interface SeekPlan {
  /** -i 前面的 -ss（秒），0 表示不跳转 */
  seek: number;
  /** 目标相对跳转点的偏移，滤镜从这里开始取帧；有索引的容器跳转本身就是精确的，为 0 */
  offset: number;
  /** 解码起点可能越过目标（没有索引的容器粗跳），滤镜要校验，越过时这次不出画面 */
  guard: boolean;
}

/**
 * 截取 time 处画面的定位方案，按顺序尝试，前一个没出画面再用下一个。
 * mp4 / mov / mkv：-ss 放在 -i 前面，按索引跳到前一个关键帧再精确解码到目标，长视频也快。
 * 其余容器：跳到目标前 SEEK_MARGINS 秒，滤镜里精确选帧；最后一个方案从头解码，慢但一定准
 */
export function seekPlans(info: VideoInfo, time: number): SeekPlan[] {
  if (time <= 0) return [{ seek: 0, offset: 0, guard: false }];
  if (info.fastSeek) return [{ seek: time, offset: 0, guard: false }];
  const plans: SeekPlan[] = [];
  for (const margin of SEEK_MARGINS) {
    // 先按 ffmpeg 参数的精度取整，偏移才和实际跳转点对得上
    const seek = Number(seconds(time - margin));
    if (seek <= 0) break;
    plans.push({ seek, offset: time - seek, guard: true });
  }
  plans.push({ seek: 0, offset: time, guard: false });
  return plans;
}

export function seekArgs(plan: SeekPlan): string[] {
  return plan.seek > 0 ? ['-ss', seconds(plan.seek)] : [];
}

/** select 表达式：时间不早于 offset 的帧 */
export function atOrAfter(offset: number): string {
  return `gte(t,${(offset - TIME_EPSILON).toFixed(6)})`;
}

/**
 * 丢掉 offset 之前的帧。start_t 是滤镜收到的第一帧的时间：粗跳之后解码器从目标之后的关键帧才开始出画面时，
 * 第一帧就晚于 offset，这时一帧都不放行，调用方据此换下一个方案，而不是把几秒之后的画面当成目标帧
 */
function selectFrom(plan: SeekPlan): string[] {
  if (plan.offset <= 0) return [];
  const from = atOrAfter(plan.offset);
  const guard = `lte(start_t,${(plan.offset + TIME_EPSILON).toFixed(6)})`;
  return [`select='${plan.guard ? `${guard}*${from}` : from}'`];
}

/**
 * 每隔 step 秒取一帧，第 k 帧是 offset + k·step 处或之后的第一帧（与逐帧跳转截图的结果一致）。
 * fps 滤镜的第 k 个输出取「取整后时间戳不超过 k」的最后一帧：默认四舍五入会取到 (k+0.5)·step 之前的最后一帧，
 * 晚了半个间隔。这里先把每帧的时间戳换成前一帧的时间（第一帧不变），再向上取整，
 * 「前一帧早于目标的最后一帧」正好就是目标处或之后的第一帧；间隔比帧距还小时 fps 会重复同一帧，也和跳转截图一致
 */
function seriesFilters(offset: number, step: number): string[] {
  const shift = offset > 0 ? `-${offset.toFixed(6)}/TB` : '';
  return [
    `setpts='if(isnan(PREV_INPTS),PTS,PREV_INPTS+${TIME_EPSILON}/TB)${shift}'`,
    `fps=fps=1/${step.toFixed(6)}:start_time=0:round=up`,
  ];
}

export interface GrabFrameOptions {
  /** 截图时间点（秒），调用方负责保证不超出画面时长 */
  time: number;
  /** 截图滤镜链，为空时输出原尺寸 */
  filters: string[];
  format: ImageFormat;
  quality: number;
  out: string;
  range?: [number, number];
}

/** 按 seekPlans 依次尝试截取 time 处的一帧，返回出了画面的方案 */
async function grabAt(
  ctx: OperationContext,
  file: string,
  info: VideoInfo,
  opts: GrabFrameOptions,
  time: number,
): Promise<SeekPlan | undefined> {
  // 粗跳时只读到目标之后这么久：目标帧最多晚一两个帧距，读不到说明这次跳过头了，不必解码到文件结尾
  const tail = Math.max(1, 2 / info.fps);
  for (const plan of seekPlans(info, time)) {
    // 单张图片当视频传进来时加 -ss 0 反而一帧都读不到，时间为 0 就不定位
    const args = seekArgs(plan);
    if (plan.offset > 0) args.push('-t', seconds(plan.offset + tail));
    args.push('-i', file, '-map', '0:V:0');
    const filters = [...selectFrom(plan), ...opts.filters];
    if (filters.length) args.push('-vf', filters.join(','));
    args.push(...singleImageOutput(opts.format, opts.quality, opts.out));
    await ctx.ffmpeg(args, { range: opts.range });
    if (await fileExists(opts.out)) return plan;
  }
  return undefined;
}

/**
 * 截取一帧：目标处或之后的第一帧。定位方式见 seekPlans，长视频也只解码一小段。
 * 在结尾附近没取到画面时（时长探测不准、可变帧率）退后 0.5 秒再试一次
 */
export async function grabFrame(
  ctx: OperationContext,
  file: string,
  info: VideoInfo,
  opts: GrabFrameOptions,
): Promise<number> {
  if (await grabAt(ctx, file, info, opts, opts.time)) return opts.time;
  const retry = Math.max(0, opts.time - 0.5);
  if (retry < opts.time && (await grabAt(ctx, file, info, opts, retry))) return retry;
  throw new Error(`在 ${formatSeconds(opts.time)} 秒处没有取到画面`);
}

/** 平均间隔不小于这个秒数时逐帧跳转截取，比整段解码快；更密时整段解码一遍反而更快 */
export const SEEK_STEP_SECONDS = 5;

export interface FrameSeriesOptions {
  /** 第一帧的时间点（秒） */
  start: number;
  /** 帧间隔（秒） */
  step: number;
  /** 最多取多少帧 */
  count: number;
  filters: string[];
  format: ImageFormat;
  quality: number;
  /** 输出目录（绝对路径）和文件名前缀，文件名为 `${prefix}-0001.${ext}` */
  dir: string;
  prefix: string;
  /** 本步骤占操作进度的区间 */
  range: [number, number];
}

export interface SeriesFrame {
  time: number;
  file: string;
}

function seriesName(prefix: string, index: number, format: ImageFormat): string {
  return `${prefix}-${String(index).padStart(4, '0')}.${format}`;
}

/**
 * 按固定间隔抽取一组画面：start、start + step、start + 2·step……处或之后的第一帧，超出画面时长的不取。
 * 间隔大时逐帧跳转；间隔小时整段解码一遍（seriesFilters），个别没解出来的帧（结尾、可变帧率）再逐帧补上
 */
export async function extractFrameSeries(
  ctx: OperationContext,
  file: string,
  info: VideoInfo,
  opts: FrameSeriesOptions,
): Promise<SeriesFrame[]> {
  const [from, to] = opts.range;
  // 时长为 0（单张图片当视频传进来）时 step 也是 0，只能逐帧取
  const decode = opts.step > 0.001 && opts.step < SEEK_STEP_SECONDS && opts.count > 1;

  if (decode) {
    // 第 k 个输出对应 start + k·step；-frames:v 卡住帧数，-t 不读多余的尾巴
    const length = Math.min(opts.count * opts.step, Math.max(0, info.videoDuration - opts.start));
    const pattern = path.join(opts.dir, `${opts.prefix}-%04d.${opts.format}`);
    const plans = seekPlans(info, opts.start);
    let plan = plans[0];
    if (plans.length > 1) {
      // 没有索引的容器粗跳可能越过起点，这时整段解码一帧都不出、白解码一整段。先只截第一帧（只解码一小段）
      // 找出能落到起点之前的跳转点，同一个文件同一个跳转点每次落到的位置都一样
      const firstFrame = {
        time: opts.start,
        filters: opts.filters,
        format: opts.format,
        quality: opts.quality,
        out: path.join(opts.dir, seriesName(opts.prefix, 1, opts.format)),
        range: [from, from] as [number, number],
      };
      plan = (await grabAt(ctx, file, info, firstFrame, opts.start)) ?? plans[plans.length - 1];
    }
    const args = [
      ...seekArgs(plan),
      '-t',
      seconds(plan.offset + length + opts.step),
      '-i',
      file,
      '-map',
      '0:V:0',
      '-vf',
      [...selectFrom(plan), ...seriesFilters(plan.offset, opts.step), ...opts.filters].join(','),
      '-frames:v',
      String(opts.count),
      ...imageEncodeArgs(opts.format, opts.quality),
      '-f',
      'image2',
      '-start_number',
      '1',
      '-y',
      pattern,
    ];
    await ctx.ffmpeg(args, { duration: length, range: opts.range });
  }

  const frames: SeriesFrame[] = [];
  const last = lastFrameTime(info);
  const span = (to - from) / opts.count;
  for (let i = 0; i < opts.count; i++) {
    const wanted = opts.start + i * opts.step;
    const name = seriesName(opts.prefix, i + 1, opts.format);
    const out = path.join(opts.dir, name);
    if (decode && (await fileExists(out))) {
      frames.push({ time: round3(wanted), file: name });
      continue;
    }
    if (wanted > info.videoDuration + 0.001) break;
    const time = await grabFrame(ctx, file, info, {
      time: Math.min(wanted, last),
      filters: opts.filters,
      format: opts.format,
      quality: opts.quality,
      out,
      range: decode ? [to, to] : [from + i * span, from + (i + 1) * span],
    });
    frames.push({ time: round3(time), file: name });
  }
  return frames;
}

/** 关键帧也解码不出来时给的提示，不把 ffmpeg 的英文原样抛给用户 */
export function assertFrames(frames: SeriesFrame[]): void {
  if (frames.length === 0) throw new Error('没有从视频中取到任何画面，请检查时间范围');
}

/**
 * 缩略图尺寸：WxH 固定尺寸；Wx? / ?xH 只给一边，另一边按比例；N% 按原尺寸的百分比
 * （与 fluent-ffmpeg 的 size 写法一致，旧客户端可能传这几种）
 */
export interface ThumbSize {
  width?: number;
  height?: number;
  percent?: number;
}

export function thumbSizeParam(name: string) {
  const message = `${name} 必须是 宽x高（如 320x240）、只给一边（320x? 或 ?x240）或百分比（1%-100%，如 50%），每边 16-${MAX_WIDTH}，总像素不超过 ${MAX_WIDTH}x${MAX_HEIGHT}`;
  const side = z
    .number({ error: message })
    .int({ error: message })
    .min(16, { error: message })
    .max(MAX_WIDTH, { error: message });
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      if (typeof v !== 'string') return v;
      const percent = /^\s*(\d{1,3}(?:\.\d{1,3})?)\s*%\s*$/.exec(v);
      if (percent) return { percent: Number(percent[1]) };
      const match = /^\s*(\d{1,5}|\?)\s*[xX*:]\s*(\d{1,5}|\?)\s*$/.exec(v);
      if (!match || (match[1] === '?' && match[2] === '?')) return null;
      return {
        width: match[1] === '?' ? undefined : Number(match[1]),
        height: match[2] === '?' ? undefined : Number(match[2]),
      };
    },
    z
      .object(
        {
          width: side.optional(),
          height: side.optional(),
          percent: z
            .number({ error: message })
            .min(1, { error: message })
            .max(100, { error: message })
            .optional(),
        },
        { error: message },
      )
      .refine((s) => (s.width ?? 1) * (s.height ?? 1) <= MAX_PIXELS, { error: message }),
  );
}

/** 缩略图的实际输出尺寸（基于显示尺寸），用来在执行前检查上限 */
export function thumbOutputSize(
  info: VideoInfo,
  size: ThumbSize,
): { width: number; height: number } {
  if (size.percent !== undefined) {
    return {
      width: Math.max(1, Math.round((info.width * size.percent) / 100)),
      height: Math.max(1, Math.round((info.height * size.percent) / 100)),
    };
  }
  if (size.width !== undefined && size.height !== undefined) {
    return { width: size.width, height: size.height };
  }
  if (size.width !== undefined) {
    return {
      width: size.width,
      height: Math.max(1, Math.round((size.width * info.height) / info.width)),
    };
  }
  const height = size.height ?? info.height;
  return { width: Math.max(1, Math.round((height * info.width) / info.height)), height };
}

export const FIT_MODES = ['stretch', 'contain', 'cover'] as const;
export type FitMode = (typeof FIT_MODES)[number];

/**
 * 缩放到目标尺寸。stretch 拉伸填满；contain 等比缩小后补边；cover 等比放大后居中裁掉多余部分。
 * 只给一边时总是等比缩放
 */
export function fitFilters(
  size: { width?: number; height?: number },
  fit: FitMode,
  padColor: string,
  format: ImageFormat,
): string[] {
  const { width, height } = size;
  if (width === undefined || height === undefined) {
    return [`scale=${width ?? -1}:${height ?? -1}`, 'setsar=1'];
  }
  if (fit === 'contain') {
    // 补边颜色半透明时（black@0、#RRGGBBAA），png / webp 先转成带透明通道的格式，否则透明度会被丢掉
    const translucent = padColor.includes('@') || /^0x[0-9A-F]{8}$/i.test(padColor);
    const alpha = translucent && format !== 'jpg' ? ['format=rgba'] : [];
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:reset_sar=1`,
      ...alpha,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`,
      'setsar=1',
    ];
  }
  if (fit === 'cover') {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=increase:reset_sar=1`,
      `crop=${width}:${height}`,
      'setsar=1',
    ];
  }
  return [`scale=${width}:${height}`, 'setsar=1'];
}
