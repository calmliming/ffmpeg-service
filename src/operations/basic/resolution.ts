import { z } from 'zod';
import { blankToUndefined } from '../../schemas/coerce';

/** 输出分辨率上限：每边 7680，总像素不超过 8K（7680x4320），竖屏 8K 也允许 */
export const MAX_SIDE = 7680;
export const MAX_PIXELS = 7680 * 4320;

export type Resolution =
  | { kind: 'fixed'; width: number; height: number }
  | { kind: 'width'; width: number }
  | { kind: 'height'; height: number }
  | { kind: 'percent'; percent: number };

export type Fit = 'contain' | 'cover' | 'stretch';

const even = (n: number) => Math.max(2, n - (n % 2));

/**
 * 解析 resolution：WxH（1280x720）、Wx?（1280x?，高度按比例）、?xH、百分比（50%）。
 * 兼容 fluent-ffmpeg 的写法，分隔符也接受 X、*、:，? 也可以写成 -1。奇数边向下取偶数（yuv420p 要求）
 */
export function parseResolution(value: string): Resolution | undefined {
  const s = value.trim();
  const percent = /^(\d{1,3}(?:\.\d{1,2})?)%$/.exec(s);
  if (percent) {
    const p = Number(percent[1]);
    return p > 0 && p <= 400 ? { kind: 'percent', percent: p } : undefined;
  }
  const match = /^(\d{1,5}|\?|-1)\s*[xX*:]\s*(\d{1,5}|\?|-1)$/.exec(s);
  if (!match) return undefined;
  const auto = (t: string) => t === '?' || t === '-1';
  const [w, h] = [match[1], match[2]];
  const valid = (n: number) => n >= 2 && n <= MAX_SIDE;
  if (auto(w) && auto(h)) return undefined;
  if (auto(h)) return valid(Number(w)) ? { kind: 'width', width: even(Number(w)) } : undefined;
  if (auto(w)) return valid(Number(h)) ? { kind: 'height', height: even(Number(h)) } : undefined;
  const width = Number(w);
  const height = Number(h);
  if (!valid(width) || !valid(height) || width * height > MAX_PIXELS) return undefined;
  return { kind: 'fixed', width: even(width), height: even(height) };
}

export function resolutionParam(name: string) {
  const message =
    `${name} 必须是 宽x高（如 1280x720）、宽x?（如 1280x?，高度按比例）、?x高 或百分比（如 50%，最大 400%），` +
    `每边 2-${MAX_SIDE}，总像素不超过 7680x4320`;
  return z.preprocess(
    (value) => {
      const v = blankToUndefined(value);
      if (typeof v === 'number') return parseResolution(`${v}x?`) ?? null;
      if (typeof v !== 'string') return v;
      return parseResolution(v) ?? null;
    },
    z.custom<Resolution>((v) => typeof v === 'object' && v !== null, { error: message }),
  );
}

// 先把非方形像素（SAR≠1，如 DV、DVD 片源）拉成方形像素，后面按显示比例缩放才不会变形
const SQUARE_PIXELS = "scale='trunc(iw*sar/2)*2':ih,setsar=1";

/**
 * 缩放滤镜链。所有分支都按显示宽高比（dar，已含 SAR）计算并以 setsar=1 结尾，
 * 输出总是方形像素；旋转元数据由 FFmpeg 解码时自动转正，滤镜看到的已经是转正后的画面
 */
export function scaleFilters(res: Resolution, fit: Fit, padColor = 'black'): string[] {
  switch (res.kind) {
    case 'width':
      return [`scale=${res.width}:'max(2,trunc(ow/dar/2)*2)':flags=lanczos`, 'setsar=1'];
    case 'height':
      return [`scale='max(2,trunc(oh*dar/2)*2)':${res.height}:flags=lanczos`, 'setsar=1'];
    case 'percent': {
      const f = res.percent / 200;
      return [
        `scale='max(2,trunc(iw*sar*${f})*2)':'max(2,trunc(ih*${f})*2)':flags=lanczos`,
        'setsar=1',
      ];
    }
    case 'fixed': {
      const { width: w, height: h } = res;
      if (fit === 'stretch') return [`scale=${w}:${h}:flags=lanczos`, 'setsar=1'];
      const mode = fit === 'contain' ? 'decrease' : 'increase';
      const scale = `scale=${w}:${h}:force_original_aspect_ratio=${mode}:reset_sar=1:force_divisible_by=2:flags=lanczos`;
      const box =
        fit === 'contain'
          ? `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`
          : `crop=${w}:${h}`;
      return [SQUARE_PIXELS, scale, box, 'setsar=1'];
    }
  }
}

/** 按比例缩放时预估输出尺寸（需要显示尺寸），固定尺寸直接返回 */
export function expectedSize(
  res: Resolution,
  display: { width: number; height: number },
): { width: number; height: number } | undefined {
  if (res.kind === 'fixed') return { width: res.width, height: res.height };
  const { width: dw, height: dh } = display;
  if (!(dw > 0 && dh > 0)) return undefined;
  const aspect = dw / dh;
  switch (res.kind) {
    case 'width':
      return { width: res.width, height: even(Math.trunc(res.width / aspect)) };
    case 'height':
      return { width: even(Math.trunc(res.height * aspect)), height: res.height };
    case 'percent':
      return {
        width: even(Math.trunc((dw * res.percent) / 100)),
        height: even(Math.trunc((dh * res.percent) / 100)),
      };
  }
}

export function sizeProblem(size: { width: number; height: number }): string | undefined {
  const { width, height } = size;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    return `输出分辨率 ${width}x${height} 超出上限（每边不超过 ${MAX_SIDE}，总像素不超过 7680x4320）`;
  }
  return undefined;
}
