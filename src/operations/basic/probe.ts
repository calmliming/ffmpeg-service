import { execFile } from 'child_process';
import path from 'path';
import { config } from '../../config';
import { probeRaw, summarizeProbe, type MediaSummary } from '../../utils/media-probe';
import type { OperationContext } from '../types';
import {
  CONTAINERS,
  isAudioCodec,
  isVideoCodec,
  type AudioContainer,
  type Container,
  type VideoContainer,
} from './formats';

interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  bit_rate?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string; start_time?: string; tags?: Record<string, string> };
}

export interface InputInfo {
  media: MediaSummary;
  /** ffprobe 的 format_name，如 "mov,mp4,m4a,3gp,3g2,mj2" */
  formatName: string;
  /** 文件的起始时间戳（秒），MPEG-TS 通常是 1.4 左右；ffmpeg 的 -ss 以它为 0 点 */
  startTime: number;
  /** 不含封面图的第一路视频流在文件里的序号（ffprobe 的 index） */
  videoIndex?: number;
  /** MP4 系列的 major_brand（"isom"、"qt  "、"M4A "），用来区分 mp4 / mov / m4a */
  majorBrand: string;
  /** 不含封面图的第一路视频流的 codec_name */
  videoCodec?: string;
  audioCodec?: string;
  /** 每一路音轨的 codec_name，按 0:a:N 的顺序 */
  audioCodecs: string[];
  audioStreams: number;
  /** 第一路音轨的码率（bit/s），容器没记录时为 0 */
  audioBitrate: number;
  /** 播放时看到的画面尺寸：已按像素宽高比（SAR）和旋转元数据换算 */
  displayWidth: number;
  displayHeight: number;
  /** 文件扩展名（不带点、小写）。只用来在 ffprobe 判定的同一容器家族里挑具体格式，不作为判断依据 */
  ext: string;
}

function parseRatio(value: string | undefined): number {
  const [num, den] = (value ?? '').split(':').map(Number);
  return num > 0 && den > 0 ? num / den : 1;
}

/** 读取输入文件信息。只调一次 ffprobe，摘要部分与 ctx.probe 完全相同 */
export async function inspectInput(ctx: OperationContext, file: string): Promise<InputInfo> {
  let raw: RawProbe;
  try {
    raw = (await probeRaw(file, ctx.signal)) as RawProbe;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`无法解析输入文件，可能不是有效的音视频文件: ${detail}`);
  }
  const media = summarizeProbe(raw as Parameters<typeof summarizeProbe>[0]);
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === 'audio');

  let displayWidth = 0;
  let displayHeight = 0;
  if (video?.width && video.height) {
    displayWidth = Math.round(video.width * parseRatio(video.sample_aspect_ratio));
    displayHeight = video.height;
    // 手机竖拍的视频存成横向画面加旋转元数据，FFmpeg 解码时会自动转正
    const rotation =
      video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ??
      Number(video.tags?.rotate ?? 0);
    if (Math.abs(rotation) % 180 === 90)
      [displayWidth, displayHeight] = [displayHeight, displayWidth];
  }

  return {
    media,
    formatName: raw.format?.format_name ?? '',
    startTime: Number(raw.format?.start_time) || 0,
    videoIndex: video?.index,
    majorBrand: (raw.format?.tags?.major_brand ?? '').trim().toLowerCase(),
    videoCodec: video?.codec_name,
    audioCodec: audios[0]?.codec_name,
    audioCodecs: audios.map((a) => a.codec_name ?? ''),
    audioStreams: audios.length,
    audioBitrate: Number(audios[0]?.bit_rate) || 0,
    displayWidth,
    displayHeight,
    ext: path.extname(file).slice(1).toLowerCase(),
  };
}

/** 源编码都在容器允许的列表里（未知编码视为不兼容） */
export function codecsFit(container: Container, info: InputInfo): boolean {
  const spec = CONTAINERS[container];
  if (info.media.video) {
    if (!spec.video || !isVideoCodec(info.videoCodec) || !spec.video.includes(info.videoCodec)) {
      return false;
    }
  }
  if (info.audioCodec) {
    if (!isAudioCodec(info.audioCodec) || !spec.audio.includes(info.audioCodec)) return false;
  }
  return true;
}

const MP4_FAMILY: readonly Container[] = ['mp4', 'mov', 'm4v', 'm4a', '3gp'];

/**
 * 按 ffprobe 识别出的封装格式判断输入属于白名单里的哪种容器，不在白名单返回 undefined。
 * 同一家族（mp4/mov/m4a、mkv/webm、ogg/opus）里再参考扩展名和 major_brand 细分
 */
export function sourceContainer(info: InputInfo): Container | undefined {
  const families = info.formatName.split(',');
  const hasVideo = Boolean(info.media.video);
  const ext = info.ext;

  if (families.includes('mov') || families.includes('mp4')) {
    const brand = info.majorBrand;
    // QuickTime 文件改名成 .mp4 很常见，里面可能是 ProRes 这类 mp4 装不下的编码，流复制时必须按真实容器输出
    if (brand === 'qt' && hasVideo) return 'mov';
    if (MP4_FAMILY.includes(ext as Container)) {
      if (ext === 'm4a' && hasVideo) return 'mp4';
      return ext as Container;
    }
    if (brand === 'qt') return 'mov';
    if (brand.startsWith('3gp')) return '3gp';
    if (brand === 'm4v') return 'm4v';
    return hasVideo ? 'mp4' : 'm4a';
  }
  if (families.includes('matroska') || families.includes('webm')) {
    // webm 只能装 VP8 / VP9 / AV1 + Opus / Vorbis，扩展名是 webm 但编码不符时按 mkv 处理
    return ext === 'webm' && codecsFit('webm', info) ? 'webm' : 'mkv';
  }
  if (families.includes('ogg')) {
    if (hasVideo) return 'ogv';
    return ext === 'opus' && info.audioCodec === 'opus' ? 'opus' : 'ogg';
  }
  const direct: Record<string, VideoContainer | AudioContainer> = {
    avi: 'avi',
    flv: 'flv',
    mpegts: 'ts',
    mpeg: 'mpg',
    mp3: 'mp3',
    wav: 'wav',
    flac: 'flac',
    aac: 'aac',
  };
  for (const name of families) {
    if (direct[name]) return direct[name];
  }
  return undefined;
}

/**
 * MPEG-TS / MPEG-PS 没有关键帧索引。FFmpeg 的输入端跳转（-ss 在 -i 前面）按时间戳二分查找时把每个包都当成关键帧，
 * 常常落在两个关键帧之间，解码器丢掉下一个关键帧之前的所有画面：截出的片段开头缺几秒甚至整段没有画面。
 * mp4 / mov / mkv / webm / avi / flv / ogg / asf 有索引或按关键帧跳转，2026-10 用 FFmpeg 8.1 逐个验证过
 */
function lacksKeyframeIndex(info: InputInfo): boolean {
  const families = info.formatName.split(',');
  return families.includes('mpegts') || families.includes('mpeg');
}

/** 找关键帧的窗口（秒）：先看起点前 30 秒，没有再看 300 秒，再没有就从头解码 */
const KEYFRAME_WINDOWS = [30, 300];
/** 跳到关键帧的解码时间戳之前这么多秒：二分查找落在解码时间戳不晚于目标的包上，余量抵消 ffprobe 打印的舍入 */
const SEEK_MARGIN = 0.1;
/** 关键帧没有 pts（MPEG-PS 常见）时按 dts 加这么多秒估计显示时间：B 帧重排延迟远小于 1 秒，宁可选早一个关键帧 */
const REORDER_SLACK = 1;

interface PacketRow {
  pts_time?: string;
  dts_time?: string;
  flags?: string;
}

/** 关键帧包里显示时间不晚于 target 的最后一个，返回它的解码时间戳（绝对时间，秒） */
export function lastKeyframeBefore(
  packets: readonly PacketRow[],
  target: number,
): number | undefined {
  let best: number | undefined;
  for (const p of packets) {
    if (!p.flags?.startsWith('K')) continue;
    const pts = Number(p.pts_time);
    const dts = Number(p.dts_time);
    const decodeAt = Number.isFinite(dts) ? dts : pts;
    const showAt = Number.isFinite(pts) ? pts : dts + REORDER_SLACK;
    if (!Number.isFinite(decodeAt) || showAt > target + 0.0005) continue;
    if (best === undefined || decodeAt > best) best = decodeAt;
  }
  return best;
}

/** 只解复用不解码，读出 [from, to]（绝对时间戳）之间视频包的时间戳和关键帧标记；读不出来返回 undefined */
function readVideoPackets(
  file: string,
  info: InputInfo,
  from: number | undefined,
  to: number,
  signal: AbortSignal,
): Promise<PacketRow[] | undefined> {
  const interval = `${from === undefined ? '' : from.toFixed(3)}%${(to + 0.001).toFixed(3)}`;
  const args = [
    '-v',
    'error',
    '-select_streams',
    info.videoIndex === undefined ? 'V:0' : String(info.videoIndex),
    '-show_entries',
    'packet=pts_time,dts_time,flags',
    '-read_intervals',
    interval,
    '-print_format',
    'json',
    file,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      config.ffprobePath,
      args,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal },
      (err, stdout) => {
        if (signal.aborted) return reject(signal.reason);
        // 查不到就当没有可用的关键帧，调用方退回从头解码：慢一些，但画面一定对
        if (err) return resolve(undefined);
        try {
          resolve((JSON.parse(stdout) as { packets?: PacketRow[] }).packets ?? []);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

/**
 * 输入端 -ss 可以安全跳到的位置（相对文件起点的秒数，不大于 start）：从这里开始解码，start 及之后的每一帧都完整。
 * 有关键帧索引的格式直接返回 start（输入端跳转本来就落在 start 之前的关键帧上）；MPEG-TS / PS 先找 start 之前的关键帧，
 * 跳到它前面一点，多解出来的部分由调用方在解码端丢掉。找不到可靠的关键帧时返回 undefined：
 * 重新编码的调用方从头解码（慢但准确），流复制的调用方只能沿用 start
 */
export async function keyframeSafeSeek(
  ctx: OperationContext,
  file: string,
  info: InputInfo,
  start: number,
): Promise<number | undefined> {
  if (start <= 0 || !info.media.video || !lacksKeyframeIndex(info)) return start;
  const target = info.startTime + start;
  for (const window of KEYFRAME_WINDOWS) {
    const from = target - window;
    const whole = from <= info.startTime;
    const packets = await readVideoPackets(
      file,
      info,
      whole ? undefined : from,
      target,
      ctx.signal,
    );
    const key = packets && lastKeyframeBefore(packets, target);
    if (key !== undefined) {
      return Math.max(0, Math.floor((key - info.startTime - SEEK_MARGIN) * 1000) / 1000);
    }
    if (whole) break;
  }
  return undefined;
}
