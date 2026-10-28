import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { bitrateParam, numberParam, toList, toNumber } from '../../schemas/coerce';
import type { DisplayVideo } from './shared';
import { num } from './shared';

export const MAX_RENDITIONS = 4;
/** 默认码率阶梯（短边像素），从不超过源画面的档位里取 */
export const STANDARD_RUNGS = [2160, 1440, 1080, 720, 480, 360, 240];
const MIN_RUNG = 144;
const MAX_RUNG = 4320;
const MAX_LONG_SIDE = 7680;
const MAX_SHORT_SIDE = 4320;
/** 每档的分片数上限，防止超长视频产出几万个文件 */
export const MAX_SEGMENTS = 2000;
/** 切片输出的帧率上限，高帧率源降到 60 */
const MAX_FPS = 60;

const renditionsMessage = `renditions 必须是逗号分隔的清晰度列表，如 1080,720,480（每个 ${MIN_RUNG}-${MAX_RUNG} 的整数，最多 ${MAX_RENDITIONS} 个）`;

export function renditionsParam() {
  return z.preprocess(
    toList,
    z
      .array(
        z.preprocess(
          (v) => toNumber(typeof v === 'string' ? v.replace(/p$/i, '') : v),
          z
            .number({ error: renditionsMessage })
            .int({ error: renditionsMessage })
            .min(MIN_RUNG, { error: renditionsMessage })
            .max(MAX_RUNG, { error: renditionsMessage }),
        ),
        { error: renditionsMessage },
      )
      .min(1, { error: renditionsMessage })
      .max(MAX_RENDITIONS, { error: renditionsMessage }),
  );
}

export function segmentDurationParam(defaultValue: number) {
  return numberParam('segmentDuration', { min: 2, max: 10, int: true }).default(defaultValue);
}

const audioBitrateMessage = 'audioBitrate 必须在 32k 到 320k 之间，如 128k';

/** 音频码率 → kbps，限制在 32-320k */
export function audioBitrateParam() {
  return bitrateParam('audioBitrate')
    .transform((value, ctx) => {
      const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value);
      const n = match ? Number(match[1]) : Number.NaN;
      const unit = match?.[2].toLowerCase();
      const kbps = unit === 'k' ? n : unit === 'm' ? n * 1000 : n / 1000;
      if (!(kbps >= 32 && kbps <= 320)) {
        ctx.issues.push({ code: 'custom', message: audioBitrateMessage, input: value });
        return z.NEVER;
      }
      return Math.round(kbps);
    })
    .default(128);
}

export interface Rendition {
  name: string;
  width: number;
  height: number;
  /** 码率上限（kbps），capped CRF 的 maxrate，bufsize 取两倍 */
  maxrateKbps: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * 根据显示尺寸和请求的清晰度算出每一档的宽高。清晰度指短边（横屏是高、竖屏是宽），
 * 不放大：高于源画面的档位丢掉，全部高于源画面时只输出源画面一档
 */
export function planRenditions(
  source: DisplayVideo,
  requested: number[] | undefined,
): { renditions: Rendition[]; dropped: number[] } {
  const { width: sw, height: sh } = source;
  const short = Math.min(sw, sh);
  // 源画面这一档向下取偶数，避免奇数短边被放大 1 像素
  const sourceRung = Math.max(2, Math.floor(short / 2) * 2);
  const dropped: number[] = [];
  let rungs: number[];
  if (requested) {
    rungs = [...new Set(requested.map(even))].filter((r) => {
      const ok = r <= sourceRung;
      if (!ok) dropped.push(r);
      return ok;
    });
    if (rungs.length === 0) rungs = [sourceRung];
  } else {
    // 和源画面太接近（90% 以上）的标准档没有意义，跳过
    rungs = [sourceRung, ...STANDARD_RUNGS.filter((r) => r < short * 0.9)];
  }
  rungs.sort((a, b) => b - a);

  const fps = Math.min(source.fps || 30, MAX_FPS);
  const renditions: Rendition[] = [];
  for (const rung of rungs) {
    const scale = rung / short;
    const width = sw <= sh ? rung : even(sw * scale);
    const height = sw <= sh ? even(sh * scale) : rung;
    if (Math.max(width, height) > MAX_LONG_SIDE || Math.min(width, height) > MAX_SHORT_SIDE) {
      dropped.push(rung);
      continue;
    }
    renditions.push({
      name: `${rung}p`,
      width,
      height,
      maxrateKbps: maxrateFor(width, height, fps),
    });
    if (renditions.length === MAX_RENDITIONS) break;
  }
  if (renditions.length === 0) {
    throw new Error(
      `源画面 ${sw}x${sh} 太大，任何一档都超过输出上限 ${MAX_LONG_SIDE}x${MAX_SHORT_SIDE}，请先缩小画面`,
    );
  }
  return { renditions, dropped };
}

/** 约 0.1 bit/像素/帧，30 帧以上的部分按一半计（高帧率相邻帧更相似） */
export function maxrateFor(width: number, height: number, fps: number): number {
  const effectiveFps = fps <= 30 ? 30 : 30 + (fps - 30) / 2;
  return Math.max(300, Math.round((width * height * effectiveFps * 0.1) / 1000));
}

/** 输出帧率：高于 60 的源降到 60；拿不到可信帧率时不改 */
export function outputFps(source: DisplayVideo): number | undefined {
  return source.fps > MAX_FPS ? MAX_FPS : undefined;
}

export function checkSegmentCount(duration: number, segmentDuration: number): void {
  const segments = Math.ceil(duration / segmentDuration);
  if (segments > MAX_SEGMENTS) {
    throw new Error(
      `视频时长 ${Math.round(duration)} 秒按每段 ${segmentDuration} 秒会切出 ${segments} 个分片，超过上限 ${MAX_SEGMENTS}，请调大 segmentDuration`,
    );
  }
}

/**
 * split + scale 的滤镜图，输出标签 [v0] [v1] …。
 * sarFilter：HLS 用 setsar=1；DASH 要求同一个 AdaptationSet 里画面比例完全一致，用统一的 setdar
 */
export function ladderFilter(renditions: Rendition[], fps: number | undefined, sarFilter: string) {
  const head = fps ? `[0:v]fps=${num(fps)},` : '[0:v]';
  if (renditions.length === 1) {
    const r = renditions[0];
    return `${head}scale=${r.width}:${r.height},${sarFilter}[v0]`;
  }
  const labels = renditions.map((_, i) => `[s${i}]`).join('');
  const branches = renditions.map(
    (r, i) => `[s${i}]scale=${r.width}:${r.height},${sarFilter}[v${i}]`,
  );
  return `${head}split=${renditions.length}${labels};${branches.join(';')}`;
}

/** H.264 编码参数：关键帧固定落在分片边界上，各档分片对齐，播放器才能无缝切换清晰度 */
export function videoEncodeArgs(
  renditions: Rendition[],
  fps: number,
  segmentDuration: number,
): string[] {
  const gop = String(Math.max(1, Math.round(fps * segmentDuration)));
  const args = [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-sc_threshold',
    '0',
    '-g',
    gop,
    '-keyint_min',
    gop,
    '-force_key_frames',
    `expr:gte(t,n_forced*${segmentDuration})`,
  ];
  renditions.forEach((r, i) => {
    args.push(`-maxrate:v:${i}`, `${r.maxrateKbps}k`, `-bufsize:v:${i}`, `${r.maxrateKbps * 2}k`);
  });
  return args;
}

/**
 * 多文件产物的输出目录写进 FFmpeg 参数：HLS 的 %v、%03d 模板会把路径里的 % 当格式符，
 * Windows 的反斜杠会让 fMP4 的 init 文件写到工作目录里，统一换成正斜杠
 */
export function muxerDir(dir: string): string {
  if (dir.includes('%')) {
    throw new Error('服务的输出目录路径里含有 %，切片文件名模板无法处理，请调整输出目录');
  }
  return dir.split(path.sep).join('/');
}

/** 目录里的全部产物（绝对路径，按名称排序） */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name))
    .sort();
}
