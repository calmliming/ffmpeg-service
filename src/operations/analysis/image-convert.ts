import fs from 'fs';
import { z } from 'zod';
import { booleanParam, colorParam, enumParam, numberParam } from '../../schemas/coerce';
import type { MediaSummary } from '../../utils/media-probe';
import { defineOperation, type OperationContext } from '../types';
import { fileInput } from './shared';

const FORMATS = ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff'] as const;
export type ImageFormat = (typeof FORMATS)[number];
const FITS = ['contain', 'cover', 'stretch'] as const;

/** WebP 的硬上限是 16383，其他格式也按它限制，避免超大图片吃光内存 */
const MAX_SIDE = 16383;
const MAX_INPUT_SIDE = 32768;
const MAX_PIXELS = 100_000_000;

/** 不传 quality 时各格式的默认质量（1-100） */
const DEFAULT_QUALITY: Record<ImageFormat, number> = {
  jpg: 85,
  webp: 80,
  avif: 60,
  png: 100,
  bmp: 100,
  tiff: 100,
};

/** 能保存透明通道的格式 */
const ALPHA_FORMATS = new Set<ImageFormat>(['png', 'webp', 'avif', 'tiff']);
/** 无损格式，quality 不起作用 */
const LOSSLESS_FORMATS = new Set<ImageFormat>(['png', 'bmp', 'tiff']);

/** AV_FRAME_DATA_EXIF 的枚举值（FFmpeg 8.1 / 9.0 实测都是 31）。sidedata 滤镜不认 EXIF 这个名字，只能写数字 */
const EXIF_SIDE_DATA = 31;

// 不带格式参数时沿用输入的格式；解码器名 → 输出格式
const SAME_FORMAT: Record<string, ImageFormat> = {
  png: 'png',
  apng: 'png',
  mjpeg: 'jpg',
  jpegls: 'jpg',
  webp: 'webp',
  // FFmpeg 9 把动态 WebP 探测成 webp_anim
  webp_anim: 'webp',
  av1: 'avif',
  bmp: 'bmp',
  tiff: 'tiff',
};

const FORMAT_ALIASES: Record<string, ImageFormat> = { jpeg: 'jpg', tif: 'tiff' };

const params = z.object({
  format: z
    .preprocess(
      (v) => (typeof v === 'string' ? (FORMAT_ALIASES[v.trim().toLowerCase()] ?? v) : v),
      enumParam('format', FORMATS),
    )
    .optional()
    .meta({
      description:
        '输出格式：png、jpg（也接受 jpeg）、webp、avif、bmp、tiff（也接受 tif）。不传时沿用输入格式（GIF 等其他格式输出 png）',
    }),
  width: numberParam('width', { min: 1, max: MAX_SIDE, int: true })
    .optional()
    .meta({
      description: `输出宽度（像素，1-${MAX_SIDE}）。只给宽或高时按比例缩放，都不给时保持原尺寸`,
    }),
  height: numberParam('height', { min: 1, max: MAX_SIDE, int: true })
    .optional()
    .meta({ description: `输出高度（像素，1-${MAX_SIDE}）` }),
  fit: enumParam('fit', FITS).default('contain').meta({
    description:
      '同时给了宽和高时的缩放方式：contain（等比缩放到框内，不裁剪，默认）、cover（等比铺满后居中裁掉多余部分，正好 宽x高）、stretch（拉伸到 宽x高，不保持比例）',
  }),
  background: colorParam('background').optional().meta({
    description:
      '背景色，如 white、#000000、#00000000（透明）。给了时：contain 补边到正好 宽x高，原图的透明区域也铺上这个颜色。不给时：jpg / bmp 的透明区域铺白色，png / webp / avif / tiff 保留透明',
  }),
  quality: numberParam('quality', { min: 1, max: 100, int: true }).optional().meta({
    description:
      '质量 1-100，越大越清晰、文件越大。默认 jpg 85、webp 80、avif 60；png / bmp / tiff 是无损格式，忽略此参数',
  }),
  lossless: booleanParam('lossless')
    .default(false)
    .meta({ description: 'webp / avif 使用无损压缩（忽略 quality），默认 false；jpg 不支持' }),
});

export type ConvertParams = z.output<typeof params>;

// 带透明通道的像素格式；pal8（调色板）可能带透明色，按有透明处理
const ALPHA_PIX_FMT = /^(yuva|gbrap|ya\d|rgba|bgra|argb|abgr|pal8)/;

export function hasAlpha(media: MediaSummary): boolean {
  return ALPHA_PIX_FMT.test(media.video?.pixFmt ?? '');
}

export function resolveFormat(
  requested: ImageFormat | undefined,
  media: MediaSummary,
): ImageFormat {
  if (requested) return requested;
  return SAME_FORMAT[media.video?.codec ?? ''] ?? 'png';
}

/** colorParam 的输出（颜色名或 0xRRGGBB[AA]，可带 @透明度）是否完全不透明 */
export function isOpaqueColor(color: string): boolean {
  const [base, alpha] = color.split('@');
  if (alpha !== undefined && Number(alpha) < 1) return false;
  const hex = /^0x[0-9A-F]{6}([0-9A-F]{2})$/.exec(base);
  return !hex || hex[1] === 'FF';
}

/** 去掉颜色的透明度：jpg / bmp 没有透明通道，底色只能是不透明的 */
export function opaqueColor(color: string): string {
  const base = color.split('@')[0];
  return /^0x[0-9A-F]{8}$/.test(base) ? base.slice(0, 8) : base;
}

export interface AlphaPlan {
  /** 把透明区域合成到这个不透明颜色上 */
  flatten?: string;
  /** contain 补边用的颜色；undefined 表示不补边 */
  padColor?: string;
  /** 输出是否带透明通道 */
  outputAlpha: boolean;
  /** 补边 / 铺底时转成了 rgba，但结果不透明：png 去掉 alpha 通道省体积 */
  dropAlpha: boolean;
}

export function planAlpha(format: ImageFormat, srcAlpha: boolean, p: ConvertParams): AlphaPlan {
  const alphaFormat = ALPHA_FORMATS.has(format);
  const bg = p.background;
  const padded = Boolean(bg && p.fit === 'contain' && p.width && p.height);
  const padColor = bg && padded ? (alphaFormat ? bg : opaqueColor(bg)) : undefined;
  let flatten: string | undefined;
  if (srcAlpha) {
    if (!alphaFormat) flatten = bg ? opaqueColor(bg) : 'white';
    // 半透明的背景色只用于补边：半透明叠半透明的结果不直观，原图的透明区域保持原样
    else if (bg && isOpaqueColor(bg)) flatten = bg;
  }
  const transparentPad = padColor !== undefined && !isOpaqueColor(padColor);
  const outputAlpha = alphaFormat && !flatten && (srcAlpha || transparentPad);
  return {
    flatten,
    padColor,
    outputAlpha,
    dropAlpha: !outputAlpha && (padColor !== undefined || flatten !== undefined),
  };
}

/** 估算输出尺寸（不知道 EXIF 旋转，两个方向都算），超限时返回错误信息 */
export function checkOutputSize(p: ConvertParams, srcW: number, srcH: number): string | undefined {
  const estimates: [number, number][] = [];
  for (const [w0, h0] of [
    [srcW, srcH],
    [srcH, srcW],
  ]) {
    if (p.width && p.height) estimates.push([p.width, p.height]);
    else if (p.width) estimates.push([p.width, Math.round((h0 * p.width) / w0)]);
    else if (p.height) estimates.push([Math.round((w0 * p.height) / h0), p.height]);
    else estimates.push([w0, h0]);
  }
  // 只有两个方向都超限才拒绝：EXIF 旋转后的真实方向只有 FFmpeg 解码时才知道。
  // 按比例算出不足 1 像素的边不用管，scale 滤镜会兜底成至少 1 像素
  const ok = ([w, h]: [number, number]) => Math.max(w, h) <= MAX_SIDE && w * h <= MAX_PIXELS;
  if (estimates.some(ok)) return undefined;
  const [w, h] = estimates[0];
  return `输出尺寸约 ${w}x${h}，超过上限（每边 ${MAX_SIDE}、总像素 ${MAX_PIXELS / 1e6} 百万），请指定更小的 width / height`;
}

/** 缩放、裁剪、补边的滤镜（只用校验过的整数、枚举和 colorParam 的颜色） */
export function scaleFilters(p: ConvertParams, padColor: string | undefined): string[] {
  const { width: w, height: h } = p;
  if (w && h) {
    if (p.fit === 'stretch') return [`scale=${w}:${h}`, 'setsar=1'];
    if (p.fit === 'cover') {
      return [
        `scale=${w}:${h}:force_original_aspect_ratio=increase:reset_sar=1`,
        `crop=${w}:${h}`,
        'setsar=1',
      ];
    }
    const filters = [
      `scale=${w}:${h}:force_original_aspect_ratio=decrease:reset_sar=1`,
      'setsar=1',
    ];
    if (padColor) {
      // 先转 rgba，补边颜色里的透明度才会生效
      filters.push('format=rgba', `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`);
    }
    return filters;
  }
  if (w) return [`scale=${w}:-1`, 'setsar=1'];
  if (h) return [`scale=-1:${h}`, 'setsar=1'];
  return [];
}

/** quality 1-100 → 各编码器的参数 */
export function encodeArgs(
  format: ImageFormat,
  quality: number,
  lossless: boolean,
  alpha: boolean,
): string[] {
  switch (format) {
    case 'jpg': {
      // mjpeg 的 q:v 是 2（最好）到 31（最差）；高质量时用 4:4:4 避免红色文字边缘发虚
      const q = Math.round(2 + ((100 - quality) * 29) / 99);
      const pix = quality >= 90 ? 'yuvj444p' : 'yuvj420p';
      return ['-c:v', 'mjpeg', '-q:v', String(q), '-pix_fmt', pix, '-update', '1', '-f', 'image2'];
    }
    case 'webp': {
      if (lossless) {
        // 无损要在 RGB 上压缩，yuv420p 会先丢掉色度
        const losslessArgs = ['-lossless', '1', '-quality', '100', '-pix_fmt', 'bgra'];
        return ['-c:v', 'libwebp', ...losslessArgs, '-f', 'webp'];
      }
      const pix = alpha ? 'yuva420p' : 'yuv420p';
      return ['-c:v', 'libwebp', '-quality', String(quality), '-pix_fmt', pix, '-f', 'webp'];
    }
    case 'avif': {
      // libaom 的 CRF 0-63，0 为无损，有损的 quality 映射到 63-1；still-picture 生成单帧 AVIF
      const crf = lossless ? 0 : Math.round(1 + ((100 - quality) * 62) / 99);
      const pix = lossless || quality >= 90 ? 'yuv444p' : 'yuv420p';
      return [
        '-c:v',
        'libaom-av1',
        '-still-picture',
        '1',
        '-crf',
        String(crf),
        '-b:v',
        '0',
        '-cpu-used',
        '6',
        '-row-mt',
        '1',
        // 只设第一路（彩色）的像素格式，第二路是 alpha 灰度图
        '-pix_fmt:v:0',
        pix,
        '-f',
        'avif',
      ];
    }
    case 'png':
      return ['-c:v', 'png', '-update', '1', '-f', 'image2'];
    case 'bmp':
      return ['-c:v', 'bmp', '-pix_fmt', 'bgr24', '-update', '1', '-f', 'image2'];
    case 'tiff':
      // tiff 编码器也接受 YUV，但多数看图软件打不开 YCbCr 的 TIFF，固定输出 RGB
      return [
        '-c:v',
        'tiff',
        '-compression_algo',
        'deflate',
        '-pix_fmt',
        alpha ? 'rgba' : 'rgb24',
        '-update',
        '1',
        '-f',
        'image2',
      ];
  }
}

/** 格式和参数的组合问题（格式可能来自输入文件，只有探测后才知道） */
export function formatError(format: ImageFormat, p: ConvertParams): string | undefined {
  if (p.lossless && format === 'jpg') return 'jpg 不支持无损压缩，请改用 png 或 webp';
  return undefined;
}

async function probeImage(ctx: OperationContext): Promise<MediaSummary> {
  let media: MediaSummary;
  try {
    media = await ctx.probe(ctx.inputs.file[0]);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(`图片无法解析: ${err instanceof Error ? err.message : String(err)}`);
  }
  const v = media.video;
  if (!v) throw new Error('输入文件不是图片（没有画面）');
  if (v.width <= 0 || v.height <= 0) {
    // FFmpeg 8 的 webp 解码器不支持动态 WebP，探测出来宽高是 0
    throw new Error(
      `无法读取图片尺寸（编码 ${v.codec || '未知'}），文件可能已损坏，或是当前 FFmpeg 不支持的格式（如动态 WebP）`,
    );
  }
  if (Math.max(v.width, v.height) > MAX_INPUT_SIDE || v.width * v.height > MAX_PIXELS) {
    throw new Error(
      `图片尺寸 ${v.width}x${v.height} 太大，最大支持每边 ${MAX_INPUT_SIDE}、总像素 ${MAX_PIXELS / 1e6} 百万`,
    );
  }
  return media;
}

export const imageConvert = defineOperation({
  name: 'image.convert',
  route: '/api/image/convert',
  title: '图片格式转换',
  description:
    '图片格式互转（png / jpg / webp / avif / bmp / tiff），可同时缩放、裁剪、补边和调整质量，并去掉 EXIF 等元数据。',
  inputs: [fileInput('image', '要转换的图片（png、jpg、webp、gif、bmp、tiff、avif 等）')],
  params,
  chainable: true,
  example: [
    '# 转成宽 800 的 webp',
    'curl -X POST http://localhost:9527/api/image/convert \\',
    '  -F "file=@photo.jpg" -F "format=webp" -F "width=800" -F "quality=80"',
    '',
    '# URL 输入：裁成 512x512 的正方形 avif',
    'curl -X POST http://localhost:9527/api/image/convert \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/photo.png","format":"avif","width":512,"height":512,"fit":"cover"}\'',
  ].join('\n'),
  notes: [
    '动图（GIF、APNG）和视频只取第一帧。动态 WebP 只有 FFmpeg 9 能解码（Docker 镜像满足），本地 FFmpeg 8 会报「无法读取图片尺寸」。',
    '带 EXIF 方向标记的照片（手机竖拍）会先按方向摆正，再去掉 EXIF；输出不含 EXIF、注释等元数据，也不带编码器标识。ICC 色彩配置在输出 png / jpg 时保留；webp / avif 不写 ICC，非 sRGB 的源图（如 Display P3 照片）转成这两种格式后颜色可能偏淡。',
    'contain 不给 background 时输出可能比框小一边；给了 background 时补边到正好 宽x高。cover 正好输出 宽x高，居中裁剪。',
    '透明通道：png / webp / avif / tiff 保留；jpg / bmp 不支持透明，透明区域铺 background（默认白色，忽略颜色里的透明度）。给了不透明的 background 时所有格式都会铺底；半透明的 background 只用于补边。avif 的透明通道以独立的 alpha 图层编码。',
    `尺寸上限：输入每边 ${MAX_INPUT_SIDE}、输出每边 ${MAX_SIDE}，总像素都不超过 ${MAX_PIXELS / 1e6} 百万。`,
    'quality 映射：jpg 对应 mjpeg q:v 31-2，webp 直接用作 libwebp quality，avif 对应 libaom CRF 63-1；quality ≥ 90 时 jpg / avif 改用 4:4:4 色度采样。lossless 只对 webp / avif 生效（avif 的无损受 RGB→YUV 转换影响，接近无损）。tiff 固定输出 8 位 RGB(A)，deflate 压缩。',
    '结果 result 里有 { format, width, height, size, quality, alpha }：输出图片的实际宽高、字节数、实际使用的质量（无损时为 null）和是否带透明通道。',
  ],
  check(p) {
    if (p.lossless && p.format === 'jpg') return 'jpg 不支持无损压缩，请改用 png 或 webp';
    if (p.fit !== 'contain' && !(p.width && p.height)) {
      return `fit=${p.fit} 需要同时提供 width 和 height`;
    }
    return undefined;
  },
  async run(ctx, p) {
    const media = await probeImage(ctx);
    const v = media.video!;
    const sizeProblem = checkOutputSize(p, v.width, v.height);
    if (sizeProblem) throw new Error(sizeProblem);

    const format = resolveFormat(p.format, media);
    const formatProblem = formatError(format, p);
    if (formatProblem) throw new Error(formatProblem);
    const quality = p.quality ?? DEFAULT_QUALITY[format];
    const plan = planAlpha(format, hasAlpha(media), p);

    // 先删掉 EXIF：FFmpeg 已按 EXIF 方向把画面摆正，原样写进 png / webp 会让看图软件再转一次
    const chain = [
      `sidedata=mode=delete:type=${EXIF_SIDE_DATA}`,
      ...scaleFilters(p, plan.padColor),
    ];
    const parts = [`[0:v]${chain.join(',')}[img]`];
    let last = 'img';
    if (plan.flatten) {
      // drawbox 填满整帧得到同尺寸的纯色底，不用事先知道摆正、缩放后的尺寸
      parts.push(
        `[${last}]format=rgba,split[fg][base]`,
        `[base]drawbox=x=0:y=0:w=iw:h=ih:color=${plan.flatten}:t=fill:replace=1[bg]`,
        '[bg][fg]overlay=format=auto[flat]',
      );
      last = 'flat';
    }
    if (plan.dropAlpha && format === 'png') {
      parts.push(`[${last}]format=rgb24[opaque]`);
      last = 'opaque';
    }
    const maps: string[] = [];
    if (format === 'avif' && plan.outputAlpha) {
      // avif muxer 把第二路画面写成 alpha 辅助图层
      parts.push(
        `[${last}]format=yuva444p,split[color][alpha_src]`,
        '[alpha_src]alphaextract[alpha]',
      );
      maps.push('-map', '[color]', '-map', '[alpha]');
    } else {
      maps.push('-map', `[${last}]`);
    }

    const output = ctx.outputPath(format);
    await ctx.ffmpeg([
      '-i',
      ctx.inputs.file[0],
      '-filter_complex',
      parts.join(';'),
      ...maps,
      '-frames:v',
      '1',
      '-map_metadata',
      '-1',
      '-bitexact',
      ...encodeArgs(format, quality, p.lossless, plan.outputAlpha),
      '-y',
      output,
    ]);

    const result = await ctx.probe(output).catch(() => undefined);
    const { size } = await fs.promises.stat(output);
    return {
      files: [output],
      primary: output,
      data: {
        format,
        width: result?.video?.width ?? null,
        height: result?.video?.height ?? null,
        size,
        quality: LOSSLESS_FORMATS.has(format) || p.lossless ? null : quality,
        alpha: plan.outputAlpha,
        sourceWidth: v.width,
        sourceHeight: v.height,
        sourceCodec: v.codec,
      },
    };
  },
});
