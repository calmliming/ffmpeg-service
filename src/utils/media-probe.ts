import { execFile } from 'child_process';
import { config } from '../config';
import { redactPaths } from './redact';

export interface VideoStreamInfo {
  codec: string;
  profile: string;
  width: number;
  height: number;
  pixFmt: string;
  /** ffprobe 的 r_frame_rate，形如 "24/1" */
  frameRate: string;
  avgFrameRate: string;
  /** 画面流自身的时长，可能比整个文件短（音轨更长时） */
  duration: number;
  /**
   * 显示时要旋转的角度（0 / 90 / 180 / 270），来自 display matrix 或旧的 rotate 标签。手机竖拍视频通常是 90 或 270：
   * 存储的是横向画面，播放器转正显示。FFmpeg 解码时默认自动转正，所以重新编码后的画面尺寸是 displayWidth x displayHeight
   */
  rotation: number;
  /** 转正后的宽高（rotation 为 90 / 270 时与 width / height 互换），以存储像素计，不含 SAR */
  displayWidth: number;
  displayHeight: number;
  /** 像素宽高比，形如 "1:1"、"4:3"；ffprobe 没报或报 0:1 时为 "1:1"。不是 1:1 的画面按存储尺寸显示会变形 */
  sar: string;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  /** 音轨自身的时长，可能比整个文件短（画面更长时）；mkv / webm 的流上没有时长，为 0 */
  duration: number;
}

export interface MediaSummary {
  duration: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
}

interface FfprobeStream {
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
  disposition?: { attached_pic?: number };
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/** display matrix 的 rotation（如 -90）或旧的 rotate 标签换算成 0 / 90 / 180 / 270 */
function streamRotation(stream: FfprobeStream): number {
  const matrix = stream.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const raw = matrix ?? Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  const quarter = Math.round(raw / 90) * 90;
  return ((quarter % 360) + 360) % 360;
}

function normalizeSar(value: string | undefined): string {
  const match = /^(\d+):(\d+)$/.exec(value ?? '');
  if (!match || Number(match[1]) === 0 || Number(match[2]) === 0) return '1:1';
  return match[1] === match[2] ? '1:1' : `${match[1]}:${match[2]}`;
}

export function summarizeProbe(data: FfprobeOutput): MediaSummary {
  const streams = data.streams ?? [];
  // 封面图在 ffprobe 里也是 video 流，不能当成画面
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration =
    parseFloat(data.format?.duration ?? '') ||
    parseFloat(video?.duration ?? '') ||
    parseFloat(audio?.duration ?? '') ||
    0;

  const rotation = video ? streamRotation(video) : 0;
  const swap = rotation === 90 || rotation === 270;
  return {
    duration,
    video: video && {
      codec: video.codec_name ?? '',
      profile: video.profile ?? '',
      width: video.width ?? 0,
      height: video.height ?? 0,
      pixFmt: video.pix_fmt ?? '',
      frameRate: video.r_frame_rate ?? '',
      avgFrameRate: video.avg_frame_rate ?? '',
      // mkv / webm 的流上没有 duration，退回整个文件的时长
      duration: parseFloat(video.duration ?? '') || duration,
      rotation,
      displayWidth: (swap ? video.height : video.width) ?? 0,
      displayHeight: (swap ? video.width : video.height) ?? 0,
      sar: normalizeSar(video.sample_aspect_ratio),
    },
    audio: audio && {
      codec: audio.codec_name ?? '',
      sampleRate: Number(audio.sample_rate) || 0,
      channels: audio.channels ?? 0,
      duration: parseFloat(audio.duration ?? '') || 0,
    },
  };
}

function runProbe(file: string, extraArgs: string[], signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      config.ffprobePath,
      ['-v', 'error', '-print_format', 'json', ...extraArgs, file],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (err, stdout, stderr) => {
        if (err) {
          if (signal?.aborted) return reject(signal.reason);
          const detail = (stderr || err.message).trim().split(/\r?\n/).slice(-3).join(' | ');
          return reject(new Error(redactPaths(detail)));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

export async function probeMedia(file: string, signal?: AbortSignal): Promise<MediaSummary> {
  const data = await runProbe(file, ['-show_format', '-show_streams'], signal);
  return summarizeProbe(data as FfprobeOutput);
}

/** ffprobe 的完整 JSON 输出（streams、format、chapters），/api/info 直接返回给客户端 */
export function probeRaw(file: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return runProbe(file, ['-show_format', '-show_streams', '-show_chapters'], signal) as Promise<
    Record<string, unknown>
  >;
}
