import { enumParam } from '../../schemas/coerce';
import { maxBoxblurRadius } from '../effects/blur';
import type { OperationContext } from '../types';
import { MAX_IMAGE_PIXELS, probeOrThrow, requireVideo, type OutputSize } from './common';

export const FIT_MODES = ['contain', 'cover', 'blur'] as const;
export type FitMode = (typeof FIT_MODES)[number];

export function fitParam(name: string) {
  return enumParam(name, FIT_MODES);
}

export const FIT_DESCRIPTION =
  '图片适配方式。contain：完整显示，空白处填背景色；cover：铺满画面，裁掉多出的部分；blur：完整显示，空白处用放大模糊的同一张图填充';

/**
 * 把输入 label 的一帧图像变成正好 W×H 的画面，输出到 [out]。
 * 先铺到纯色背景上再叠加，PNG 的透明部分会显示背景色而不是编码后的随机颜色。
 * background 必须是 colorParam 的输出
 */
export function fitGraph(
  input: string,
  fit: FitMode,
  size: OutputSize,
  background: string,
): string {
  const { width: w, height: h } = size;
  const base = `color=c=${background}:s=${w}x${h}:r=1[fit_bg]`;
  const contain = `scale=${w}:${h}:force_original_aspect_ratio=decrease:reset_sar=1:flags=lanczos,setsar=1`;
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase:reset_sar=1:flags=lanczos,crop=${w}:${h},setsar=1`;
  const center = 'overlay=x=(W-w)/2:y=(H-h)/2:shortest=1:format=auto';
  if (fit === 'contain') {
    return `${base};[${input}]${contain}[fit_fg];[fit_bg][fit_fg]${center}[out]`;
  }
  if (fit === 'cover') {
    return `${base};[${input}]${cover}[fit_fg];[fit_bg][fit_fg]overlay=0:0:shortest=1:format=auto[out]`;
  }
  // boxblur 要求 2 × 半径 < 平面短边（亮度、色度平面分别算，色度是亮度的一半），按输出尺寸算好写成数字；
  // 极小的画面（如 4x4）上限是 0，这时等于不模糊
  const short = Math.min(w, h);
  const radius = Math.min(Math.max(1, Math.floor(short / 20)), maxBoxblurRadius(short));
  const chroma = Math.min(
    Math.max(1, Math.floor(radius / 2)),
    maxBoxblurRadius(Math.floor(short / 2)),
  );
  return [
    base,
    `[${input}]split=2[fit_a][fit_b]`,
    `[fit_a]${cover},boxblur=lr=${radius}:lp=2:cr=${chroma}:cp=2,eq=brightness=-0.08[fit_blur]`,
    `[fit_b]${contain}[fit_fg]`,
    `[fit_bg][fit_blur]overlay=0:0:shortest=1:format=auto[fit_base]`,
    `[fit_base][fit_fg]${center}[out]`,
  ].join(';');
}

export interface StillOptions {
  fit: FitMode;
  size: OutputSize;
  background: string;
  /** 输出到 workDir 的文件名（.png 或 .y4m） */
  name: string;
  /** 取输入文件里的哪一路，默认第一路画面；音频内嵌封面传 `0:<index>` */
  stream?: string;
  /** 错误信息里怎么称呼这张图 */
  label: string;
  /** 调用方已经用 checkImage 检查过，不再探测 */
  checked?: boolean;
  /** 这一步占整个操作进度的区间（ctx.ffmpeg 结束时会汇报到区间终点） */
  range: [number, number];
}

/** 探测图片：必须能解码出画面，且不超过像素上限 */
export async function checkImage(
  ctx: OperationContext,
  file: string,
  label: string,
): Promise<void> {
  const media = await probeOrThrow((f) => ctx.probe(f), file, label);
  const image = requireVideo(media, label);
  if (image.width * image.height > MAX_IMAGE_PIXELS) {
    throw new Error(
      `${label}分辨率 ${image.width}x${image.height} 太大，上限 1 亿像素（如 10000x10000）`,
    );
  }
}

/**
 * 解码一次图片，适配成输出尺寸的静态画面存进 workDir。之后的命令只读这张小图，
 * 不必每帧重新解码原图（大尺寸 JPEG 解一次要几十毫秒）。动图只取第一帧
 */
export async function renderStill(
  ctx: OperationContext,
  file: string,
  opts: StillOptions,
): Promise<string> {
  if (!opts.stream && !opts.checked) await checkImage(ctx, file, opts.label);
  const stream = opts.stream ?? '0:v:0';
  const yuv = opts.name.endsWith('.y4m');
  // FFmpeg 7.1 起会协商色彩范围：JPEG 是全范围（pc），不显式转换的话一路带到 H.264，
  // 输出被标成 yuvj420p，不少播放器按有限范围显示会发灰或过曝
  const graph = fitGraph(stream, opts.fit, opts.size, opts.background).replace(
    /\[out\]$/,
    yuv ? ',scale=out_range=tv,format=yuv420p[out]' : ',format=rgb24[out]',
  );
  const target = ctx.tempPath(opts.name);
  await ctx
    .ffmpeg(
      ['-i', file, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-y', target],
      {
        range: opts.range,
      },
    )
    .catch((err: Error) => {
      if (ctx.signal.aborted) throw err;
      throw new Error(`${opts.label}处理失败: ${err.message}`);
    });
  return target;
}
