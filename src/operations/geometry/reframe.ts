import { z } from 'zod';
import { booleanParam, colorParam, enumParam, numberParam, sizeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  aspectParam,
  audioPassthroughArgs,
  evenFloor,
  evenOffset,
  evenRound,
  fitsMaxSize,
  MAX_SHORT_SIDE,
  maxSizeError,
  MP4_OUTPUT,
  num,
  parseAspect,
  probeVideo,
  requireDuration,
  VIDEO_ENCODE,
} from './common';

const DEFAULT_SHORT_SIDE = 1080;

const params = z.object({
  aspect: aspectParam().optional().meta({
    description:
      '目标比例：16:9、9:16、1:1、4:3、3:4、4:5、21:9。默认分辨率短边 1080（如 9:16 为 1080x1920），可用 shortSide 调整',
  }),
  size: sizeParam('size')
    .optional()
    .meta({ description: '目标分辨率 宽x高（如 1080x1920），不能和 aspect 同时使用' }),
  shortSide: numberParam('shortSide', { min: 144, max: MAX_SHORT_SIDE, int: true })
    .optional()
    .meta({
      description: '配合 aspect 使用：输出短边像素（144-4320），默认 1080，如 720 得到 720x1280',
    }),
  background: enumParam('background', ['blur', 'color']).default('blur').meta({
    description:
      '背景：blur（源画面放大铺满后模糊，默认）、color（纯色，颜色由 backgroundColor 指定）',
  }),
  backgroundColor: colorParam('backgroundColor')
    .default('black')
    .meta({ description: 'background=color 时的背景色，默认 black' }),
  blur: numberParam('blur', { min: 1, max: 50, int: true })
    .default(20)
    .meta({ description: 'background=blur 时的模糊强度 1-50，默认 20' }),
  dim: numberParam('dim', { min: 0, max: 0.9 }).default(0).meta({
    description: 'background=blur 时背景压暗的比例 0-0.9，默认 0（不压暗），0.3 让主体更突出',
  }),
  upscale: booleanParam('upscale').default(true).meta({
    description:
      '源画面比目标小时是否放大前景。默认 true（前景放大到贴边）；false 时前景保持原尺寸居中，四周都是背景',
  }),
});

type ReframeParams = z.output<typeof params>;

/** 目标画布尺寸（偶数）；超出上限时返回错误信息 */
export function reframeCanvas(p: ReframeParams): { width: number; height: number } | string {
  let width: number;
  let height: number;
  if (p.size) {
    width = evenFloor(p.size.width);
    height = evenFloor(p.size.height);
  } else if (p.aspect) {
    const { w, h } = parseAspect(p.aspect);
    const short = evenFloor(p.shortSide ?? DEFAULT_SHORT_SIDE);
    if (w >= h) {
      height = short;
      width = evenRound((short * w) / h);
    } else {
      width = short;
      height = evenRound((short * h) / w);
    }
  } else {
    return '请提供 aspect（如 9:16）或 size（如 1080x1920）';
  }
  if (!fitsMaxSize(width, height)) return maxSizeError('输出尺寸', width, height);
  return { width, height };
}

export interface ReframeLayout {
  fgWidth: number;
  fgHeight: number;
  x: number;
  y: number;
}

/** 前景等比缩放到画布内并居中 */
export function reframeLayout(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  upscale: boolean,
): ReframeLayout {
  let factor = Math.min(canvasW / srcW, canvasH / srcH);
  if (!upscale) factor = Math.min(factor, 1);
  const fgWidth = Math.min(canvasW, evenRound(srcW * factor));
  const fgHeight = Math.min(canvasH, evenRound(srcH * factor));
  return {
    fgWidth,
    fgHeight,
    x: evenOffset((canvasW - fgWidth) / 2),
    y: evenOffset((canvasH - fgHeight) / 2),
  };
}

/**
 * 模糊背景：先缩到画布的 1/4 再模糊、再放大回来。全尺寸 boxblur 很慢，缩小后模糊再放大效果几乎一样，
 * 还顺带让模糊更柔和。boxblur 要求 2 × 半径 < 平面短边（相等也报 Invalid argument），
 * 同一个半径也用在 yuv420p 只有一半大小的色度平面上，所以按小图色度平面的短边夹住
 */
export function blurBackgroundChain(
  canvasW: number,
  canvasH: number,
  strength: number,
  dim: number,
): string[] {
  const bw = evenRound(canvasW / 4);
  const bh = evenRound(canvasH / 4);
  const short = Math.min(bw, bh);
  const chromaShort = Math.floor(short / 2);
  const limit = Math.max(0, Math.floor((chromaShort - 1) / 2));
  const radius = Math.min(limit, Math.max(1, Math.round((strength / 100) * (short / 2))));
  const chain = [
    `scale=${bw}:${bh}:force_original_aspect_ratio=increase:reset_sar=1`,
    `crop=${bw}:${bh}`,
    'format=yuv420p',
  ];
  if (radius >= 1) chain.push(`boxblur=${radius}:2`);
  chain.push(`scale=${canvasW}:${canvasH}`);
  // 有限范围 YUV 的黑电平是 16，按 (Y-16)*k+16 压暗，避免直接乘系数把暗部压成死黑
  if (dim > 0) chain.push(`lutyuv=y=(val-16)*${num(1 - dim)}+16`);
  chain.push('setsar=1');
  return chain;
}

export const reframe = defineOperation({
  name: 'video.reframe',
  route: '/api/video/reframe',
  title: '改画幅（横转竖）',
  description:
    '把视频改成另一种画幅（如横屏转 9:16 竖屏）：完整保留原画面，居中放在模糊背景或纯色背景上，不裁掉任何内容。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '要改画幅的视频' }],
  params,
  chainable: true,
  example: [
    '# 横屏视频转 9:16 竖屏，模糊背景',
    'curl -X POST http://localhost:9527/api/video/reframe \\',
    '  -F "file=@landscape.mp4" -F "aspect=9:16" -F "background=blur"',
    '',
    '# 转 1:1 正方形，白色背景，720x720（URL 输入）',
    'curl -X POST http://localhost:9527/api/video/reframe \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","aspect":"1:1","shortSide":720,"background":"color","backgroundColor":"white"}\'',
  ].join('\n'),
  notes: [
    'aspect 和 size 二选一。aspect 的默认分辨率短边为 1080：16:9 → 1920x1080、9:16 → 1080x1920、1:1 → 1080x1080、4:3 → 1440x1080、3:4 → 1080x1440、4:5 → 1080x1350、21:9 → 2520x1080；用 shortSide 改短边。',
    '放大行为：默认（upscale=true）前景等比缩放到刚好贴住画布的一边，源分辨率低于目标时会被放大（如 640x360 转 9:16 时前景放大到 1080 宽）；upscale=false 时前景不放大，保持原尺寸居中。想避免放大也可以把 shortSide 设成和源视频相当的值。',
    '源比例和目标比例相同时直接缩放，不生成背景。',
    `输出最大 7680x${MAX_SHORT_SIDE}（竖屏 ${MAX_SHORT_SIDE}x7680），宽高都是偶数。带旋转元数据的手机视频按摆正后的画面计算。`,
    '画面重新编码为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。',
  ],
  check(p) {
    if (p.aspect && p.size) return 'aspect 和 size 不能同时使用';
    if (p.shortSide !== undefined && !p.aspect) return 'shortSide 只能和 aspect 一起使用';
    const canvas = reframeCanvas(p);
    return typeof canvas === 'string' ? canvas : undefined;
  },
  async run(ctx, p) {
    const canvas = reframeCanvas(p);
    if (typeof canvas === 'string') throw new Error(canvas);
    const source = await probeVideo(ctx, ctx.inputs.file[0], '输入文件');
    const duration = requireDuration(source, '输入文件');
    const { width: W, height: H } = canvas;
    const fg = reframeLayout(source.width, source.height, W, H, p.upscale);
    ctx.log(
      `改画幅 ${source.width}x${source.height} → ${W}x${H}，前景 ${fg.fgWidth}x${fg.fgHeight} @ (${fg.x}, ${fg.y})`,
    );

    const pre = source.prefilters;
    const fgScale = `scale=${fg.fgWidth}:${fg.fgHeight}`;
    let graph: string;
    if (fg.fgWidth === W && fg.fgHeight === H) {
      graph = `[0:V:0]${[...pre, fgScale, 'setsar=1', 'format=yuv420p'].join(',')}[v]`;
    } else if (p.background === 'color') {
      const pad = `pad=${W}:${H}:${fg.x}:${fg.y}:color=${p.backgroundColor}`;
      graph = `[0:V:0]${[...pre, fgScale, 'setsar=1', pad, 'format=yuv420p'].join(',')}[v]`;
    } else {
      const bg = blurBackgroundChain(W, H, p.blur, p.dim);
      graph = [
        `[0:V:0]${[...pre, 'split=2'].join(',')}[bgsrc][fgsrc]`,
        `[bgsrc]${bg.join(',')}[bg]`,
        `[fgsrc]${fgScale},setsar=1[fg]`,
        `[bg][fg]overlay=${fg.x}:${fg.y},format=yuv420p[v]`,
      ].join(';');
    }

    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(
      [
        '-i',
        source.file,
        '-filter_complex',
        graph,
        '-map',
        '[v]',
        '-map',
        '0:a:0?',
        ...VIDEO_ENCODE,
        ...audioPassthroughArgs(source.media),
        ...MP4_OUTPUT,
        '-y',
        output,
      ],
      { duration },
    );
    return {
      files: [output],
      data: { width: W, height: H, foreground: fg },
    };
  },
});
