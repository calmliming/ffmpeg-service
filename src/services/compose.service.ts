import fs from 'fs';
import path from 'path';
import { runFFmpeg } from '../utils/ffmpeg-run';
import { probeMedia, type MediaSummary } from '../utils/media-probe';

export type ComposeStage = 'normalizing' | 'merging';

export interface ComposeFilesOptions {
  videoFiles: string[];
  musicFile?: string;
  musicVolume: number;
  muteOriginalAudio: boolean;
  output: string;
  /** 中间文件目录，不能是 /api/files 对外提供下载的目录 */
  workDir: string;
  /** 中间文件名前缀，通常是 taskId */
  prefix: string;
  onStage?: (stage: ComposeStage) => void;
  /** fraction 是下载之后全部工作的完成比例 0-1，segment 是正在处理的片段序号（从 1 开始） */
  onProgress?: (fraction: number, segment: number) => void;
  /** 取消任务时中止正在跑的 ffprobe / ffmpeg */
  signal?: AbortSignal;
}

export interface ComposeResult {
  duration: number;
  normalized: boolean;
  reasons: string[];
}

export interface NormalizeTarget {
  width: number;
  height: number;
  fps: string;
  sampleRate: number;
}

const PROBE_CONCURRENCY = 4;
// 2026-10-27 用 FFmpeg 8.1 实测：VP8、Theora、Vorbis 流复制进 mp4 报 codec not currently supported，
// VP9、Opus、FLAC 可以。只放行验证过的，其余一律先转码
const MP4_VIDEO_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);
const MP4_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'ac3', 'eac3', 'alac', 'flac']);
/** 需要统一转码时，转码占下载后进度的比例，剩下的给最终拼接 */
const NORMALIZE_SHARE = 0.8;

export function videoSignature(media: MediaSummary): string {
  const v = media.video;
  if (!v) return 'none';
  let signature = `${v.codec} ${v.profile} ${v.width}x${v.height} ${v.pixFmt} ${v.frameRate}fps`;
  // 旋转信息和像素宽高比都在容器 / 码流头里，concat 流复制只保留第 1 个文件的：
  // 方向不同的片段会被转歪，SAR 不同的片段会按第 1 个的比例显示而变形，必须算作不一致
  if (v.rotation) signature += ` 旋转 ${v.rotation}°`;
  if (v.sar && v.sar !== '1:1') signature += ` SAR ${v.sar}`;
  return signature;
}

export function audioSignature(media: MediaSummary): string {
  const a = media.audio;
  return a ? `${a.codec} ${a.sampleRate}Hz ${a.channels}ch` : '无音轨';
}

/**
 * concat demuxer 流复制要求每个片段的编码参数完全一致，否则输出会花屏或音画错位。
 * 返回不一致的原因列表，空数组表示可以直接流复制。消除原声时不需要比较音频。
 */
export function findIncompatibilities(items: MediaSummary[], checkAudio: boolean): string[] {
  const reasons: string[] = [];
  const firstVideo = videoSignature(items[0]);
  const firstAudio = audioSignature(items[0]);
  // 参数一致也不一定能流复制：输出是 mp4，装不下的编码必须转码
  const videoCodec = items[0].video?.codec;
  if (videoCodec && !MP4_VIDEO_CODECS.has(videoCodec)) {
    reasons.push(`视频编码 ${videoCodec} 不能直接放进 MP4`);
  }
  const audioCodec = items[0].audio?.codec;
  if (checkAudio && audioCodec && !MP4_AUDIO_CODECS.has(audioCodec)) {
    reasons.push(`音频编码 ${audioCodec} 不能直接放进 MP4`);
  }
  items.forEach((item, i) => {
    if (i === 0) return;
    const video = videoSignature(item);
    if (video !== firstVideo) {
      reasons.push(`第 ${i + 1} 个视频画面参数 ${video} 与第 1 个 ${firstVideo} 不同`);
    }
    if (checkAudio) {
      const audio = audioSignature(item);
      if (audio !== firstAudio) {
        reasons.push(`第 ${i + 1} 个视频音频参数 ${audio} 与第 1 个 ${firstAudio} 不同`);
      }
    }
  });
  return reasons;
}

function parseRate(rate: string): number {
  const [num, den] = rate.split('/').map(Number);
  if (!Number.isFinite(num)) return 0;
  return den ? num / den : num;
}

function isSaneRate(rate: string): boolean {
  const value = parseRate(rate);
  return value > 0 && value <= 120;
}

/**
 * 统一转码时以第 1 个视频的分辨率和帧率为准。分辨率取转正后的显示尺寸：
 * FFmpeg 解码时会按旋转信息自动转正，手机竖拍（存储 1280x720 + 旋转 90 度）解出来就是 720x1280
 */
export function pickNormalizeTarget(items: MediaSummary[]): NormalizeTarget {
  const first = items[0].video;
  const even = (n: number, fallback: number) => Math.max(2, Math.round((n || fallback) / 2) * 2);
  let fps = '30';
  if (first && isSaneRate(first.frameRate)) fps = first.frameRate;
  else if (first && isSaneRate(first.avgFrameRate)) fps = first.avgFrameRate;
  const sampleRate =
    items.find((m) => m.audio && m.audio.sampleRate > 0)?.audio?.sampleRate ?? 48000;
  // 按第 1 个视频实际显示的形状定画布：先按 SAR 把存储宽度换算成方形像素，再按旋转交换宽高
  let width = first?.width ?? 0;
  let height = first?.height ?? 0;
  const [sarNum, sarDen] = (first?.sar ?? '1:1').split(':').map(Number);
  if (sarNum > 0 && sarDen > 0) width = (width * sarNum) / sarDen;
  if (first && (first.rotation === 90 || first.rotation === 270)) [width, height] = [height, width];
  return {
    width: even(width, 1280),
    height: even(height, 720),
    fps,
    sampleRate,
  };
}

export function buildNormalizeArgs(
  input: string,
  media: MediaSummary,
  target: NormalizeTarget,
  withAudio: boolean,
  output: string,
): string[] {
  const { width: w, height: h, fps, sampleRate } = target;
  const args = ['-i', input];
  const ownAudio = withAudio && Boolean(media.audio);
  if (withAudio && !ownAudio) {
    // 没有音轨的片段补静音，否则拼接后后面片段的声音会整体提前
    args.push('-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=stereo`);
  }
  // reset_sar：按显示比例（考虑 SAR）缩放成方形像素。否则非方形像素的片段按存储宽高算比例，
  // 再被 setsar=1 拉回方形像素后画面变形、多出黑边
  const scale = `scale=${w}:${h}:force_original_aspect_ratio=decrease:reset_sar=1`;
  const pad = `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
  args.push(
    '-map',
    '0:v:0',
    '-vf',
    `${scale},${pad},setsar=1,fps=${fps},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
  );
  if (withAudio) {
    // 音轨比画面短时补静音到画面长度，避免误差逐段累积成音画不同步
    args.push(
      '-map',
      ownAudio ? '0:a:0' : '1:a:0',
      '-af',
      'apad',
      '-c:a',
      'aac',
      '-ar',
      String(sampleRate),
      '-ac',
      '2',
    );
    // 不能用 -shortest：画面在重新编码时它会让音轨多出约 0.5 秒（2026-10-26 实测），
    // 拼接后每段画面之间都留下空洞，总时长变长、帧率也乱掉。按画面时长精确截断
    const videoDuration = media.video?.duration ?? 0;
    if (videoDuration > 0) args.push('-t', videoDuration.toFixed(3));
    else args.push('-shortest');
  } else {
    args.push('-an');
  }
  args.push('-y', output);
  return args;
}

function formatVolume(volume: number): string {
  return String(Math.round(Math.min(Math.max(volume, 0), 1) * 1000) / 1000);
}

export interface MergeArgsOptions {
  concatFile: string;
  musicFile?: string;
  musicVolume: number;
  muteOriginalAudio: boolean;
  /** 拼接后的视频是否带音轨 */
  videosHaveAudio: boolean;
  output: string;
}

export function buildMergeArgs(o: MergeArgsOptions): string[] {
  const args = ['-f', 'concat', '-safe', '0', '-i', o.concatFile];
  const volume = formatVolume(o.musicVolume);

  if (o.musicFile) {
    args.push('-i', o.musicFile);
    if (o.muteOriginalAudio || !o.videosHaveAudio) {
      // 只有音乐一路音频时，-shortest 会按音乐长度截断视频，apad 让音乐不够长时补静音
      args.push('-filter_complex', `[1:a]volume=${volume},apad[outa]`);
    } else {
      // amix 默认 normalize 会把两路都减半，音乐结束后原声又跳回原音量；关掉后用 alimiter 防削波
      const mix = 'amix=inputs=2:duration=first:dropout_transition=0:normalize=0';
      args.push(
        '-filter_complex',
        `[1:a]volume=${volume}[bgm];[0:a][bgm]${mix},alimiter=limit=0.97:level=0:latency=1[outa]`,
      );
    }
    args.push('-map', '0:v', '-map', '[outa]', '-c:v', 'copy', '-c:a', 'aac', '-shortest');
  } else if (o.muteOriginalAudio) {
    args.push('-map', '0:v', '-c:v', 'copy', '-an');
  } else {
    args.push('-c', 'copy');
  }

  // moov 放到文件头，浏览器拿到 downloadUrl 可以边下边播
  args.push('-movflags', '+faststart', '-y', o.output);
  return args;
}

export function concatListContent(files: string[]): string {
  // ffconcat 里单引号要写成 '\''，否则带引号的路径会被截断
  const lines = files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`);
  return ['ffconcat version 1.0', ...lines].join('\n') + '\n';
}

/** 根据已输出时长推算正在处理第几个片段（从 1 开始） */
export function segmentAt(seconds: number, durations: number[]): number {
  let elapsed = 0;
  for (let i = 0; i < durations.length; i++) {
    elapsed += durations[i];
    if (seconds < elapsed) return i + 1;
  }
  return durations.length;
}

async function mapLimit<T, R>(
  items: T[],
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

/**
 * 把已经下载到本地的视频拼接成一个文件，可选混入背景音乐。
 * 片段参数一致时直接流复制，不一致时先逐个转码成统一参数（一次只转一个，控制内存）。
 * 中间文件都放在 workDir，结束时无论成败都会清理；失败时也会删掉不完整的 output。
 */
export async function composeFiles(opts: ComposeFilesOptions): Promise<ComposeResult> {
  const { videoFiles, musicFile, output, workDir, prefix, signal } = opts;
  // 取消时原样抛出 signal.reason，不包装成「第 N 个视频…失败」，引擎据此把任务记为已取消
  const wrap = (message: string) => (err: Error) => {
    if (signal?.aborted) throw err;
    throw new Error(`${message}: ${err.message}`);
  };

  const videos = await mapLimit(videoFiles, PROBE_CONCURRENCY, async (file, i) => {
    const info = await probeMedia(file, signal).catch(wrap(`第 ${i + 1} 个视频无法解析`));
    if (!info.video) throw new Error(`第 ${i + 1} 个文件不包含视频画面`);
    return info;
  });
  if (musicFile) {
    const music = await probeMedia(musicFile, signal).catch(wrap('背景音乐无法解析'));
    if (!music.audio) throw new Error('背景音乐不包含音频');
  }

  const durations = videos.map((v) => v.duration);
  const total = durations.reduce((sum, d) => sum + d, 0);
  const keepOriginalAudio = !opts.muteOriginalAudio;
  const reasons = findIncompatibilities(videos, keepOriginalAudio);
  const normalized = reasons.length > 0;
  const videosHaveAudio = keepOriginalAudio && videos.some((v) => v.audio);
  const mergeStart = normalized ? NORMALIZE_SHARE : 0;
  const created: string[] = [];

  try {
    let segments = videoFiles;
    if (normalized) {
      opts.onStage?.('normalizing');
      const target = pickNormalizeTarget(videos);
      segments = [];
      let before = 0;
      for (let i = 0; i < videoFiles.length; i++) {
        const segment = path.join(workDir, `${prefix}_norm_${i}.mp4`);
        created.push(segment);
        const args = buildNormalizeArgs(videoFiles[i], videos[i], target, videosHaveAudio, segment);
        await runFFmpeg(args, {
          signal,
          onTime: (t) => {
            const done = total > 0 ? (before + Math.min(t, durations[i])) / total : 0;
            opts.onProgress?.(done * NORMALIZE_SHARE, i + 1);
          },
        }).catch(wrap(`第 ${i + 1} 个视频转码失败`));
        before += durations[i];
        segments.push(segment);
      }
    }

    opts.onStage?.('merging');
    const concatFile = path.join(workDir, `${prefix}_concat.txt`);
    created.push(concatFile);
    await fs.promises.writeFile(concatFile, concatListContent(segments));

    const args = buildMergeArgs({
      concatFile,
      musicFile,
      musicVolume: opts.musicVolume,
      muteOriginalAudio: opts.muteOriginalAudio,
      videosHaveAudio,
      output,
    });
    await runFFmpeg(args, {
      signal,
      onTime: (t) => {
        const ratio = total > 0 ? Math.min(t / total, 1) : 0;
        opts.onProgress?.(mergeStart + ratio * (1 - mergeStart), segmentAt(t, durations));
      },
    }).catch(wrap('视频合成失败'));
  } catch (err) {
    await fs.promises.rm(output, { force: true }).catch(() => {});
    throw err;
  } finally {
    await Promise.all(created.map((file) => fs.promises.rm(file, { force: true }).catch(() => {})));
  }

  return { duration: total, normalized, reasons };
}
