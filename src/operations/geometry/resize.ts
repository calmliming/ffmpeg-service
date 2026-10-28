import { z } from 'zod';
import { colorParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  encodeVideoFilter,
  evenFloor,
  evenRound,
  fitsMaxSize,
  MAX_LONG_SIDE,
  maxSizeError,
  probeVideo,
  requireDuration,
} from './common';

const MODES = ['fit', 'fill', 'stretch'] as const;
const ALGORITHMS = ['bicubic', 'bilinear', 'lanczos', 'neighbor', 'area'] as const;

const params = z.object({
  width: numberParam('width', { min: 2, max: MAX_LONG_SIDE, int: true })
    .optional()
    .meta({ description: '目标宽度（像素）。只给 width 时高度按原比例计算' }),
  height: numberParam('height', { min: 2, max: MAX_LONG_SIDE, int: true })
    .optional()
    .meta({ description: '目标高度（像素）。只给 height 时宽度按原比例计算' }),
  scale: numberParam('scale', { min: 0.01, max: 10 }).optional().meta({
    description: '按倍数缩放（0.01-10，如 0.5 为缩小一半），不能和 width / height 同时使用',
  }),
  mode: enumParam('mode', MODES).default('fit').meta({
    description:
      '同时给 width 和 height 时的缩放方式：fit（等比缩放到框内，空白处补 padColor，默认）、fill（等比放大铺满后居中裁掉多余部分）、stretch（拉伸到精确尺寸）',
  }),
  padColor: colorParam('padColor')
    .default('black')
    .meta({ description: 'fit 模式补边的颜色，如 black、white、#1E90FF，默认 black' }),
  algorithm: enumParam('algorithm', ALGORITHMS).default('bicubic').meta({
    description:
      '缩放算法：bicubic（默认）、bilinear（更快）、lanczos（更锐利）、area（大幅缩小时更干净）、neighbor（最近邻，像素风放大不糊）',
  }),
});

type ResizeParams = z.output<typeof params>;

export interface ResizePlan {
  width: number;
  height: number;
  filters: string[];
}

/** 根据参数和源画面尺寸算出输出尺寸和滤镜；尺寸超限时抛出中文错误 */
export function planResize(p: ResizeParams, srcW: number, srcH: number): ResizePlan {
  const flags = `flags=${p.algorithm}`;
  let width: number;
  let height: number;
  let filters: string[];
  if (p.width !== undefined && p.height !== undefined) {
    width = evenFloor(p.width);
    height = evenFloor(p.height);
    if (p.mode === 'fit') {
      filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:reset_sar=1:force_divisible_by=2:${flags}`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${p.padColor}`,
      ];
    } else if (p.mode === 'fill') {
      filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase:reset_sar=1:${flags}`,
        `crop=${width}:${height}`,
      ];
    } else {
      filters = [`scale=${width}:${height}:${flags}`];
    }
  } else {
    if (p.scale !== undefined) {
      width = evenRound(srcW * p.scale);
      height = evenRound(srcH * p.scale);
    } else if (p.width !== undefined) {
      width = evenFloor(p.width);
      height = evenRound((srcH * width) / srcW);
    } else if (p.height !== undefined) {
      height = evenFloor(p.height);
      width = evenRound((srcW * height) / srcH);
    } else {
      throw new Error('请提供 width、height 或 scale 中的至少一个');
    }
    filters = [`scale=${width}:${height}:${flags}`];
  }
  if (!fitsMaxSize(width, height)) throw new Error(maxSizeError('缩放后的尺寸', width, height));
  return { width, height, filters: [...filters, 'setsar=1'] };
}

export const resize = defineOperation({
  name: 'video.resize',
  route: '/api/video/resize',
  title: '缩放画面',
  description:
    '把视频缩放到指定宽高或倍数；同时指定宽高时可选等比补边（fit）、铺满裁切（fill）或拉伸（stretch）。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '要缩放的视频' }],
  params,
  chainable: true,
  example: [
    '# 等比缩放到 1280x720 框内，空白处补黑边',
    'curl -X POST http://localhost:9527/api/video/resize \\',
    '  -F "file=@input.mp4" -F "width=1280" -F "height=720" -F "mode=fit"',
    '',
    '# 只给宽度，高度按比例；URL 输入',
    'curl -X POST http://localhost:9527/api/video/resize \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","width":720}\'',
  ].join('\n'),
  notes: [
    '三选一：width 和 / 或 height，或 scale 倍数。只给一边时另一边按原比例计算并取偶数。',
    'mode 和 padColor 只在同时给 width 和 height 时生效；只给一边或用 scale 时总是保持比例。',
    `输出最大 ${MAX_LONG_SIDE}x4320（竖屏 4320x${MAX_LONG_SIDE}），宽高奇数会向下取偶数（H.264 yuv420p 的要求）。`,
    '带旋转元数据的手机视频按摆正后的画面计算；非方形像素先换算成方形像素，输出总是方形像素（SAR 1:1）。',
    '画面重新编码为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。任务结果 result 里返回 { width, height }。',
  ],
  check(p) {
    const hasSize = p.width !== undefined || p.height !== undefined;
    if (p.scale !== undefined && hasSize) return 'scale 不能和 width / height 同时使用';
    if (p.scale === undefined && !hasSize) return '请提供 width、height 或 scale 中的至少一个';
    if (p.width !== undefined && p.height !== undefined) {
      const w = evenFloor(p.width);
      const h = evenFloor(p.height);
      if (!fitsMaxSize(w, h)) return maxSizeError('输出尺寸', w, h);
    }
    return undefined;
  },
  async run(ctx, p) {
    const source = await probeVideo(ctx, ctx.inputs.file[0], '输入文件');
    requireDuration(source, '输入文件');
    const plan = planResize(p, source.width, source.height);
    ctx.log(`缩放 ${source.width}x${source.height} → ${plan.width}x${plan.height}`);
    const output = await encodeVideoFilter(ctx, source, [...source.prefilters, ...plan.filters]);
    return { files: [output], data: { width: plan.width, height: plan.height } };
  },
});
