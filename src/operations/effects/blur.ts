import { z } from 'zod';
import { enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  VIDEO_INPUT,
  assertFrameSize,
  assertStartInside,
  checkTimeWindow,
  enableExpr,
  evenCropFilter,
  graphArgs,
  inspectVideo,
  regionsParam,
  toPixels,
  type Region,
} from './shared';

/**
 * 区域在画面内的最小边长：boxblur 要求 2 × 半径 < 平面短边，4 像素时亮度半径才能为 1；
 * 这时 yuv420p 的色度平面只有 2 像素，色度半径只能为 0（2x2 的色度采样本来就很粗，不模糊也看不出差别）
 */
const MIN_SIDE = 4;
/** pixelize 的块大小上限 */
const MAX_BLOCK = 1024;

interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  enable?: string;
}

/**
 * 把一维区间对齐到偶数并夹在画面内：yuv420p 的 crop 会把奇数坐标悄悄向下取整，
 * 先对齐好才能保证 overlay 贴回的位置与裁出来的位置一致
 */
function fitEven(start: number, end: number, size: number): [number, number] {
  const limit = Math.floor(size / 2) * 2;
  let a = Math.max(0, Math.floor(start / 2) * 2);
  let b = Math.min(limit, Math.ceil(end / 2) * 2);
  if (b - a < MIN_SIDE) {
    b = Math.min(limit, a + MIN_SIDE);
    a = Math.max(0, b - MIN_SIDE);
  }
  return [a, b - a];
}

export function resolveRegions(
  regions: Region[] | undefined,
  opts: {
    unit: 'px' | 'percent';
    width: number;
    height: number;
    duration: number;
    startTime?: number;
    endTime?: number;
  },
): PixelRegion[] {
  const { width: W, height: H } = opts;
  const list = regions && regions.length > 0 ? regions : [{ x: 0, y: 0, width: W, height: H }];
  return list.map((region, i) => {
    const r = regions && regions.length > 0 ? toPixels(region, opts.unit, W, H) : region;
    const label = `regions 第 ${i + 1} 个区域`;
    if (r.x >= W || r.y >= H || r.x + r.width <= 0 || r.y + r.height <= 0) {
      throw new Error(`${label}完全在画面（${W}x${H}）之外`);
    }
    const [x, w] = fitEven(r.x, r.x + r.width, W);
    const [y, h] = fitEven(r.y, r.y + r.height, H);
    const start = region.startTime ?? opts.startTime;
    const end = region.endTime ?? opts.endTime;
    if (start !== undefined && end !== undefined && end <= start) {
      throw new Error(`${label}的 endTime 必须大于 startTime`);
    }
    assertStartInside(start, opts.duration, `${label}的开始时间`);
    return { x, y, width: w, height: h, enable: enableExpr(start, end) };
  });
}

/**
 * boxblur 在某个平面上允许的最大半径：FFmpeg 要求 2 × 半径 < 该平面的短边（等于一半也会报
 * Invalid argument），短边不足 3 像素时只能为 0（不模糊）
 */
export function maxBoxblurRadius(side: number): number {
  return Math.max(0, Math.floor((side - 1) / 2));
}

/** 强度 1-100 换算成区域短边一半的百分比：同样的强度在大小不同的区域上看起来差不多 */
export function regionFilter(mode: 'blur' | 'mosaic', strength: number, w: number, h: number) {
  const short = Math.min(w, h);
  const base = short / 2;
  if (mode === 'mosaic') {
    const block = Math.min(MAX_BLOCK, Math.max(2, Math.round((base * strength) / 100)));
    return `pixelize=width=${block}:height=${block}:mode=avg`;
  }
  // 每个平面各自夹住：yuv420p 的色度平面宽高都只有亮度的一半（向下取整更保守，区域边长本来就是偶数）
  const lumaLimit = maxBoxblurRadius(short);
  const chromaLimit = maxBoxblurRadius(Math.floor(short / 2));
  const luma = Math.min(lumaLimit, Math.max(1, Math.round((base * strength) / 100)));
  const chroma = Math.min(chromaLimit, Math.max(1, Math.ceil(luma / 2)));
  return `boxblur=luma_radius=${luma}:luma_power=2:chroma_radius=${chroma}:chroma_power=2`;
}

const params = z.object({
  regions: regionsParam('regions')
    .optional()
    .meta({
      description:
        '要处理的矩形区域，最多 10 个。可写 JSON 数组 [{"x":10,"y":20,"width":200,"height":80}]、' +
        '[[10,20,200,80]] 或字符串 "10,20,200,80;300,40,120,60"；对象形式还可以带各自的 startTime / endTime。不传则处理整个画面',
    }),
  unit: enumParam('unit', ['px', 'percent'] as const)
    .default('px')
    .meta({ description: '区域坐标单位：px 像素（默认）或 percent（相对画面宽高的百分比 0-100）' }),
  mode: enumParam('mode', ['blur', 'mosaic'] as const)
    .default('blur')
    .meta({ description: '效果：blur 模糊（默认）或 mosaic 马赛克' }),
  strength: numberParam('strength', { min: 1, max: 100 }).default(30).meta({
    description:
      '强度 1-100，默认 30。blur 时为模糊半径、mosaic 时为色块边长，按区域短边一半的百分比计算',
  }),
  startTime: timeParam('startTime')
    .optional()
    .meta({ description: '从第几秒开始处理，秒数或 HH:MM:SS；不传则从头开始' }),
  endTime: timeParam('endTime')
    .optional()
    .meta({ description: '处理到第几秒，秒数或 HH:MM:SS；不传则到结尾' }),
});

export const blur = defineOperation({
  name: 'video.blur',
  route: '/api/video/blur',
  title: '区域模糊 / 马赛克',
  description:
    '对视频中的一个或多个矩形区域做模糊或马赛克处理（人脸、车牌、隐私信息），不指定区域时处理整个画面。',
  inputs: VIDEO_INPUT,
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/blur \\',
    '  -F "file=@input.mp4" \\',
    '  -F \'regions=[{"x":40,"y":30,"width":160,"height":90},{"x":400,"y":300,"width":120,"height":60,"startTime":2,"endTime":5}]\' \\',
    '  -F "mode=mosaic" -F "strength=40"',
    '',
    '# URL 输入（JSON）',
    'curl -X POST http://localhost:9527/api/video/blur \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","regions":"10,10,30,20","unit":"percent"}\'',
  ].join('\n'),
  notes: [
    '最多 10 个区域；超出画面的部分会被裁掉，完全在画面外的区域返回错误。坐标按旋转后的显示方向计算（手机竖拍视频也一样）。',
    '区域坐标会对齐到偶数像素，在画面内的边长至少 4 像素（更小的区域会被扩大到 4 像素）。',
    '全局 startTime / endTime 对所有区域生效，对象形式的区域可以用自己的 startTime / endTime 覆盖。',
    '画面重新编码为 H.264（CRF 23），音轨原样保留（不兼容 mp4 的音频编码会转为 AAC），输出 mp4；奇数宽高会裁掉 1 像素。',
  ],
  check(p) {
    return checkTimeWindow(p.startTime, p.endTime);
  },
  async run(ctx, p) {
    const input = await inspectVideo(ctx, ctx.inputs.file[0]);
    assertFrameSize(input);
    const regions = resolveRegions(p.regions, {
      unit: p.unit,
      width: input.width,
      height: input.height,
      duration: input.duration,
      startTime: p.startTime,
      endTime: p.endTime,
    });

    // 每个区域单独裁出来处理再贴回原位：滤镜只作用在区域内，时间窗口用 overlay 的 enable 控制
    const n = regions.length;
    const splits = ['[base]', ...regions.map((_, i) => `[s${i}]`)].join('');
    const parts = [`[0:${input.videoIndex}]format=yuv420p,split=${n + 1}${splits}`];
    regions.forEach((r, i) => {
      const effect = regionFilter(p.mode, p.strength, r.width, r.height);
      parts.push(`[s${i}]crop=${r.width}:${r.height}:${r.x}:${r.y},${effect}[r${i}]`);
    });
    const even = evenCropFilter(input.width, input.height);
    regions.forEach((r, i) => {
      const from = i === 0 ? '[base]' : `[o${i - 1}]`;
      const enable = r.enable ? `:enable=${r.enable}` : '';
      const last = i === n - 1;
      const tail = last ? `${even ? `,${even}` : ''}[vout]` : `[o${i}]`;
      parts.push(`${from}[r${i}]overlay=x=${r.x}:y=${r.y}${enable}${tail}`);
    });

    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(graphArgs(input, parts.join(';'), output), { duration: input.duration });
    return { files: [output] };
  },
});
