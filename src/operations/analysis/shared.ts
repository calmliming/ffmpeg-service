import fs from 'fs';
import { probeRaw, summarizeProbe, type MediaSummary } from '../../utils/media-probe';
import type { InputSlot, OperationContext } from '../types';

/** 分析结果里区间列表的上限：防止异常素材（频闪、噪声）产生几十万条区间撑爆任务详情 */
export const MAX_INTERVALS = 10000;

export function fileInput(kind: InputSlot['kind'], description: string): InputSlot {
  return { name: 'file', kind, required: true, description };
}

/** 四舍五入到指定小数位；-0 统一成 0 */
export function round(n: number, digits: number): number {
  const factor = 10 ** digits;
  const value = Math.round(n * factor) / factor;
  return value === 0 ? 0 : value;
}

/** 数字写进滤镜参数：最多 6 位小数，避免出现 1e-7 这种滤镜表达式不认的写法 */
export function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`内部错误：非法的数值 ${n}`);
  return String(Number(n.toFixed(6)));
}

/** 解析 FFmpeg 打印的分贝值，-inf / inf / nan 返回 null */
export function parseDb(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 能当作真实帧率的上限（不含）。慢动作素材有 240、480、960 fps，
 * 1000/1（mkv / webm 的毫秒时间基）、90000/1（MPEG-TS 时间基）这类是 ffprobe 猜不出帧率时给的时间基
 */
const MAX_REAL_FPS = 1000;

/** 帧率 "30000/1001" → 29.97；解析不了或不可信（0、时间基）时返回 0 */
export function parseFrameRate(rate: string | undefined): number {
  const match = /^(\d{1,9})(?:\/(\d{1,9}))?$/.exec((rate ?? '').trim());
  if (!match) return 0;
  const value = Number(match[1]) / (match[2] === undefined ? 1 : Number(match[2]) || 0);
  return Number.isFinite(value) && value > 0 && value < MAX_REAL_FPS ? value : 0;
}

/**
 * 实际解码出的帧率。r_frame_rate 是能精确表示所有时间戳的最低帧率，隔行素材是场频（50i 报 50）、
 * 可变帧率素材可能偏高；avg_frame_rate 是实际的平均帧率。两个都可信时取较小的
 */
export function videoFps(media: MediaSummary): number {
  const r = parseFrameRate(media.video?.frameRate);
  const avg = parseFrameRate(media.video?.avgFrameRate);
  return r > 0 && avg > 0 ? Math.min(r, avg) : r || avg;
}

/** 探测输入并要求有对应的流。上传和 URL 下载的文件扩展名都不可信，一律以探测结果为准 */
export async function probeInput(
  ctx: OperationContext,
  require: 'audio' | 'video',
): Promise<MediaSummary> {
  let media: MediaSummary;
  try {
    media = await ctx.probe(ctx.inputs.file[0]);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(`输入文件无法解析: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (require === 'audio' && !media.audio) {
    throw new Error('输入文件没有音轨，无法进行音频分析');
  }
  if (require === 'video' && (!media.video || media.video.width <= 0)) {
    throw new Error('输入文件没有视频画面，无法进行画面分析');
  }
  return media;
}

/**
 * 从 FFmpeg 的 stderr 里取出某个滤镜打印的日志（去掉 [Parsed_xxx_0 @ 0x...] 前缀）。
 * 只认行首的滤镜前缀：输入文件的元数据也会打印到 info 日志里，恶意文件可以在标题里伪造 silence_start 之类的文字，
 * 但元数据行总是以空格缩进开头，匹配不到行首前缀
 */
export function filterLogLines(stderr: string, filter: string): string[] {
  const prefix = new RegExp(`^\\[Parsed_${filter}_\\d+ @ [^\\]]+\\] (.*)$`);
  const lines: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = prefix.exec(line);
    if (match) lines.push(match[1]);
  }
  return lines;
}

export interface Interval {
  start: number;
  end: number;
  duration: number;
}

export function makeInterval(start: number, end: number): Interval {
  const s = Math.max(0, start);
  const e = Math.max(s, end);
  return { start: round(s, 3), end: round(e, 3), duration: round(e - s, 3) };
}

export function totalDuration(intervals: Interval[]): number {
  return round(
    intervals.reduce((sum, i) => sum + (i.end - i.start), 0),
    3,
  );
}

/** 区间的补集，用于从静音区间得到有声区间；小于 1 毫秒的缝隙忽略 */
export function complement(intervals: Interval[], duration: number): Interval[] {
  const result: Interval[] = [];
  let cursor = 0;
  for (const item of intervals) {
    if (item.start - cursor > 0.001) result.push(makeInterval(cursor, item.start));
    cursor = Math.max(cursor, item.end);
  }
  if (duration - cursor > 0.001) result.push(makeInterval(cursor, duration));
  return result;
}

/** 读 workDir 里分析滤镜写的元数据文件；滤镜一帧都没打印时文件可能不存在 */
export async function readOptionalFile(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * 解析 metadata / ametadata 滤镜 mode=print 写出的文件：
 * frame:0    pts:12800   pts_time:1
 * lavfi.scene_score=0.400000
 */
export function parseMetadataFrames(text: string): { time: number; values: Map<string, string> }[] {
  const frames: { time: number; values: Map<string, string> }[] = [];
  let current: { time: number; values: Map<string, string> } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const header = /^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/.exec(line);
    if (header) {
      current = { time: Number(header[1]), values: new Map() };
      frames.push(current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) current.values.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return frames.filter((f) => Number.isFinite(f.time));
}

export interface DisplayVideo {
  media: MediaSummary;
  /** 播放器里看到的宽高：已按旋转元数据摆正、按像素宽高比换算成方形像素 */
  width: number;
  height: number;
  fps: number;
}

interface RawStream {
  codec_type?: string;
  sample_aspect_ratio?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

function parseRatio(value: string | undefined): number {
  const match = /^(\d{1,9}):(\d{1,9})$/.exec((value ?? '').trim());
  if (!match || Number(match[1]) === 0 || Number(match[2]) === 0) return 1;
  return Number(match[1]) / Number(match[2]);
}

/**
 * 探测视频的显示尺寸。FFmpeg 默认按旋转元数据把画面摆正后才进滤镜（手机竖拍的视频编码尺寸是横的），
 * 多码率切片要按显示尺寸算每一档的宽高
 */
export async function probeDisplay(ctx: OperationContext): Promise<DisplayVideo> {
  let raw: { streams?: RawStream[] };
  try {
    raw = (await probeRaw(ctx.inputs.file[0], ctx.signal)) as { streams?: RawStream[] };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(`输入文件无法解析: ${err instanceof Error ? err.message : String(err)}`);
  }
  const media = summarizeProbe(raw as Parameters<typeof summarizeProbe>[0]);
  const video = media.video;
  if (!video || video.width <= 0 || video.height <= 0) {
    throw new Error('输入文件没有视频画面');
  }
  const stream = raw.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const matrix = stream?.side_data_list?.find((d) => d.side_data_type === 'Display Matrix');
  const rotation =
    typeof matrix?.rotation === 'number' ? matrix.rotation : -Number(stream?.tags?.rotate ?? 0);
  const quarterTurn = Math.abs(Math.round((Number(rotation) || 0) / 90)) % 2 === 1;
  const sar = parseRatio(stream?.sample_aspect_ratio);
  // 像素宽高比作用在编码画面的宽度上，旋转之后才交换宽高
  const codedDisplayWidth = video.width * sar;
  const width = quarterTurn ? video.height : codedDisplayWidth;
  const height = quarterTurn ? codedDisplayWidth : video.height;
  return { media, width: Math.round(width), height: Math.round(height), fps: videoFps(media) };
}
