import { z } from 'zod';
import { enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  aspectParam,
  encodeVideoFilter,
  evenFloor,
  evenOffset,
  fitsMaxSize,
  maxSizeError,
  parseAspect,
  probeVideo,
  requireDuration,
  type Aspect,
} from './common';

const ANCHORS = ['center', 'top', 'bottom', 'left', 'right'] as const;
type Anchor = (typeof ANCHORS)[number];

const params = z.object({
  x: numberParam('x', { min: 0, max: 8192, int: true })
    .optional()
    .meta({ description: '裁剪区域左上角的横坐标（像素），和 y 一起使用；不传时按 anchor 摆放' }),
  y: numberParam('y', { min: 0, max: 8192, int: true })
    .optional()
    .meta({ description: '裁剪区域左上角的纵坐标（像素），和 x 一起使用' }),
  width: numberParam('width', { min: 2, max: 8192, int: true })
    .optional()
    .meta({ description: '裁剪宽度（像素），和 height 一起使用；奇数会向下取偶数' }),
  height: numberParam('height', { min: 2, max: 8192, int: true })
    .optional()
    .meta({ description: '裁剪高度（像素），和 width 一起使用；奇数会向下取偶数' }),
  aspect: aspectParam().optional().meta({
    description:
      '按比例裁出最大的区域：16:9、9:16、1:1、4:3、3:4、4:5、21:9。不能和 width / height 同时使用',
  }),
  anchor: enumParam('anchor', ANCHORS).optional().meta({
    description:
      '没有给 x / y 时裁剪区域的位置：center（居中，默认）、top、bottom、left、right（贴边，另一个方向居中）',
  }),
});

type CropParams = z.output<typeof params>;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function place(anchor: Anchor, srcW: number, srcH: number, w: number, h: number) {
  let x = (srcW - w) / 2;
  let y = (srcH - h) / 2;
  if (anchor === 'top') y = 0;
  if (anchor === 'bottom') y = srcH - h;
  if (anchor === 'left') x = 0;
  if (anchor === 'right') x = srcW - w;
  return { x: evenOffset(x), y: evenOffset(y) };
}

/** 按比例取最大的区域：先按宽算高，放不下再按高算宽（整数乘除，避免浮点误差多出 1 像素） */
export function aspectCropSize(aspect: Aspect, srcW: number, srcH: number) {
  const { w: aw, h: ah } = parseAspect(aspect);
  let width = evenFloor(srcW);
  let height = evenFloor(Math.floor((srcW * ah) / aw));
  if (height > srcH) {
    height = evenFloor(srcH);
    width = evenFloor(Math.floor((srcH * aw) / ah));
  }
  return { width, height };
}

/**
 * 根据参数和源画面尺寸算出裁剪区域；超出画面时抛出中文错误。
 * srcW / srcH 是滤镜看到的尺寸（偶数），frame 是取偶数之前的真实尺寸（奇数尺寸的源视频比前者多 1），默认相同
 */
export function computeCropRect(
  p: CropParams,
  srcW: number,
  srcH: number,
  frame: { width: number; height: number } = { width: srcW, height: srcH },
): CropRect {
  const anchor = p.anchor ?? 'center';
  if (p.aspect) {
    const { width, height } = aspectCropSize(p.aspect, srcW, srcH);
    return { ...place(anchor, srcW, srcH, width, height), width, height };
  }
  // 按用户看到的真实画面校验：641x361 的视频选整幅画面（或贴右 / 下边）是合法的，
  // 之后向下取偶数，偶数的坐标 + 偶数的宽高不超过奇数的真实尺寸，也就不超过取偶数后的画面
  const realW = Math.max(frame.width, srcW);
  const realH = Math.max(frame.height, srcH);
  const w = p.width ?? realW;
  const h = p.height ?? realH;
  if (w > realW || h > realH) {
    throw new Error(`裁剪尺寸 ${w}x${h} 超出了源视频画面 ${realW}x${realH}`);
  }
  const width = Math.min(evenFloor(w), srcW);
  const height = Math.min(evenFloor(h), srcH);
  if (p.x === undefined || p.y === undefined) {
    return { ...place(anchor, srcW, srcH, width, height), width, height };
  }
  if (p.x + w > realW || p.y + h > realH) {
    throw new Error(
      `裁剪区域（x=${p.x}, y=${p.y}, ${w}x${h}）超出了源视频画面 ${realW}x${realH}，` +
        `x + width 不能大于 ${realW}，y + height 不能大于 ${realH}`,
    );
  }
  // 4:2:0 色度按 2 像素对齐，坐标向下取偶数；宽高也向下取了偶数，区域仍在画面内
  return { x: evenOffset(p.x), y: evenOffset(p.y), width, height };
}

export const crop = defineOperation({
  name: 'video.crop',
  route: '/api/video/crop',
  title: '裁剪画面',
  description:
    '按像素区域（x、y、width、height）或按比例（aspect，如 9:16）裁剪视频画面，音轨原样保留。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '要裁剪的视频' }],
  params,
  chainable: true,
  example: [
    '# 横屏裁成居中的 9:16 竖屏',
    'curl -X POST http://localhost:9527/api/video/crop \\',
    '  -F "file=@input.mp4" -F "aspect=9:16"',
    '',
    '# 按像素区域裁剪（URL 输入）',
    'curl -X POST http://localhost:9527/api/video/crop \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","x":100,"y":50,"width":640,"height":360}\'',
  ].join('\n'),
  notes: [
    '二选一：width + height（可选 x + y，不给坐标时按 anchor 摆放，默认居中），或 aspect 按比例裁出最大区域。',
    '坐标基于播放器里看到的画面：带旋转元数据的手机视频先摆正再裁剪，非方形像素先换算成方形像素。',
    '裁剪区域必须完全落在源画面内，否则任务失败并提示源画面尺寸；宽高和坐标会向下取偶数（H.264 yuv420p 的要求），奇数尺寸的源视频（如 641x361）选整幅画面时得到 640x360。',
    '裁剪后的画面最大 7680x4320（竖屏 4320x7680），只有超过 8K 的源视频才可能超出。',
    '任务结果 result 里返回实际的裁剪区域 { x, y, width, height, sourceWidth, sourceHeight }。',
    '画面重新编码为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。',
  ],
  check(p) {
    const hasRect = p.width !== undefined || p.height !== undefined;
    const hasPoint = p.x !== undefined || p.y !== undefined;
    if (p.aspect && (hasRect || hasPoint)) return 'aspect 不能和 x / y / width / height 同时使用';
    if (!p.aspect && !hasRect)
      return '请提供 width 和 height（按像素裁剪），或 aspect（按比例裁剪）';
    if (hasRect && (p.width === undefined || p.height === undefined)) {
      return 'width 和 height 必须同时提供';
    }
    if (hasPoint && (p.x === undefined || p.y === undefined)) return 'x 和 y 必须同时提供';
    if (hasPoint && p.anchor) return 'anchor 不能和 x / y 同时使用';
    return undefined;
  },
  async run(ctx, p) {
    const source = await probeVideo(ctx, ctx.inputs.file[0], '输入文件');
    requireDuration(source, '输入文件');
    const frame = { width: source.frameWidth, height: source.frameHeight };
    const rect = computeCropRect(p, source.width, source.height, frame);
    if (!fitsMaxSize(rect.width, rect.height)) {
      throw new Error(`${maxSizeError('裁剪后的画面', rect.width, rect.height)}，请缩小裁剪区域`);
    }
    ctx.log(
      `裁剪 ${frame.width}x${frame.height} → ${rect.width}x${rect.height} @ (${rect.x}, ${rect.y})`,
    );
    const output = await encodeVideoFilter(ctx, source, [
      ...source.prefilters,
      `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`,
      'setsar=1',
    ]);
    return {
      files: [output],
      data: { ...rect, sourceWidth: frame.width, sourceHeight: frame.height },
    };
  },
});
