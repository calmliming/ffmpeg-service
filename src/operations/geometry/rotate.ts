import { z } from 'zod';
import { booleanParam, colorParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  audioPassthroughArgs,
  encodeVideoFilter,
  fitsMaxSize,
  maxSizeError,
  MP4_OUTPUT,
  num,
  numericEnumParam,
  probeVideo,
  requireDuration,
} from './common';

const FLIPS = ['none', 'horizontal', 'vertical', 'both'] as const;
type Flip = (typeof FLIPS)[number];

const params = z.object({
  angle: numericEnumParam('angle', ['90', '180', '270'])
    .optional()
    .meta({ description: '顺时针旋转 90、180 或 270 度（无损的像素转置，画布随之变化）' }),
  degrees: numberParam('degrees', { min: -360, max: 360 }).optional().meta({
    description:
      '任意角度旋转（-360 到 360，正数顺时针）。90 的倍数等同于 angle；其他角度会扩大画布并用 fillColor 填充四角',
  }),
  flip: enumParam('flip', FLIPS).default('none').meta({
    description:
      '镜像翻转：none（默认）、horizontal（左右）、vertical（上下）、both（左右加上下）。和旋转一起用时先旋转再翻转',
  }),
  fillColor: colorParam('fillColor')
    .default('black')
    .meta({ description: '任意角度旋转时空白处的颜色，默认 black' }),
  expand: booleanParam('expand').default(true).meta({
    description:
      '任意角度旋转时是否扩大画布以容纳整个画面。默认 true；false 保持原尺寸，四角会被裁掉',
  }),
  lossless: booleanParam('lossless').default(false).meta({
    description:
      '只改旋转 / 镜像元数据、不重新编码（秒级完成、画质无损）。只支持 90 度倍数的旋转和翻转，播放器需支持显示矩阵',
  }),
});

type RotateParams = z.output<typeof params>;

export interface RotatePlan {
  /** 顺时针 90 度的次数（0-3），任意角度旋转时为 undefined */
  quarterTurns?: number;
  /** 任意角度（顺时针，度） */
  degrees?: number;
  flip: Flip;
}

export function planRotation(p: RotateParams): RotatePlan {
  if (p.angle !== undefined) return { quarterTurns: Number(p.angle) / 90, flip: p.flip };
  if (p.degrees !== undefined) {
    const turns = p.degrees / 90;
    if (Math.abs(turns - Math.round(turns)) < 1e-9) {
      return { quarterTurns: ((Math.round(turns) % 4) + 4) % 4, flip: p.flip };
    }
    return { degrees: p.degrees, flip: p.flip };
  }
  return { quarterTurns: 0, flip: p.flip };
}

function flipFilters(flip: Flip): string[] {
  if (flip === 'horizontal') return ['hflip'];
  if (flip === 'vertical') return ['vflip'];
  if (flip === 'both') return ['hflip', 'vflip'];
  return [];
}

/** 任意角度旋转后的画布：扩大时取外接矩形并向上取偶数，保证四角不被裁掉 */
export function rotatedCanvas(
  width: number,
  height: number,
  degrees: number,
  expand: boolean,
): { width: number; height: number } {
  if (!expand) return { width, height };
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // 去掉浮点误差，免得 320.0000001 被向上取成 322
  const up = (n: number) => Math.max(2, Math.ceil(Number(n.toFixed(6)) / 2) * 2);
  return { width: up(width * cos + height * sin), height: up(width * sin + height * cos) };
}

// 能直接复制进 mp4 的画面编码
const MP4_COPY_VIDEO = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);

export const rotate = defineOperation({
  name: 'video.rotate',
  route: '/api/video/rotate',
  title: '旋转 / 翻转',
  description:
    '顺时针旋转 90 / 180 / 270 度、任意角度旋转或镜像翻转视频；也可以只改旋转元数据实现无损秒转。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '要旋转的视频' }],
  params,
  chainable: true,
  example: [
    '# 顺时针旋转 90 度',
    'curl -X POST http://localhost:9527/api/video/rotate \\',
    '  -F "file=@input.mp4" -F "angle=90"',
    '',
    '# 左右镜像',
    'curl -X POST http://localhost:9527/api/video/rotate \\',
    '  -F "file=@input.mp4" -F "flip=horizontal"',
    '',
    '# 无损旋转（只改元数据，不重新编码；URL 输入）',
    'curl -X POST http://localhost:9527/api/video/rotate \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","angle":270,"lossless":true}\'',
  ].join('\n'),
  notes: [
    'angle、degrees、flip 至少给一个；angle 和 degrees 不能同时使用。同时给旋转和 flip 时先旋转再翻转。',
    '旋转基于播放器里看到的方向：手机拍的带旋转元数据的视频先摆正再旋转，输出不再带旋转元数据，播放器不会重复旋转。',
    '任意角度旋转默认扩大画布（expand=true），输出尺寸是旋转后的外接矩形。重新编码的输出上限 7680x4320（竖屏 4320x7680），超出时任务失败；lossless 不受此限制。',
    'lossless=true 时不重新编码，只写入新的显示矩阵（和原有旋转叠加）和镜像标记，画质无损、速度极快；要求画面编码为 H.264 / H.265 / AV1 / VP9 / MPEG-4，只支持 90 度倍数。浏览器、手机和主流播放器都认显示矩阵，但少数剪辑软件或老播放器会忽略它。原视频自带的镜像标记会被覆盖。',
    '重新编码时画面为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。',
  ],
  check(p) {
    if (p.angle !== undefined && p.degrees !== undefined) return 'angle 和 degrees 不能同时使用';
    if (p.angle === undefined && p.degrees === undefined && p.flip === 'none') {
      return '请提供 angle（90 / 180 / 270）、degrees 或 flip 中的至少一个';
    }
    if (p.lossless && planRotation(p).quarterTurns === undefined) {
      return 'lossless 只支持 90 度倍数的旋转，任意角度请去掉 lossless 重新编码';
    }
    return undefined;
  },
  async run(ctx, p) {
    const source = await probeVideo(ctx, ctx.inputs.file[0], '输入文件');
    const duration = requireDuration(source, '输入文件');
    const plan = planRotation(p);

    if (p.lossless && plan.quarterTurns !== undefined) {
      const codec = source.media.video?.codec ?? '';
      if (!MP4_COPY_VIDEO.has(codec)) {
        throw new Error(
          `lossless 模式要求画面编码为 H.264 / H.265 / AV1 / VP9 / MPEG-4，当前是 ${codec || '未知'}，请去掉 lossless 重新编码`,
        );
      }
      // -display_rotation 是逆时针角度并且整体覆盖原显示矩阵，所以要和原有旋转叠加；先旋转再翻转与滤镜路径一致（2026-10 实测）
      let rotation = (((source.rotation - plan.quarterTurns * 90) % 360) + 360) % 360;
      if (rotation > 180) rotation -= 360;
      const inputArgs = ['-display_rotation', num(rotation)];
      if (plan.flip === 'horizontal' || plan.flip === 'both') inputArgs.push('-display_hflip');
      if (plan.flip === 'vertical' || plan.flip === 'both') inputArgs.push('-display_vflip');
      const output = ctx.outputPath('mp4');
      ctx.log(`无损旋转：显示矩阵 ${source.rotation}° → ${rotation}°，翻转 ${plan.flip}`);
      await ctx.ffmpeg(
        [
          ...inputArgs,
          '-i',
          source.file,
          '-map',
          '0:V:0',
          '-map',
          '0:a:0?',
          '-c:v',
          'copy',
          // Safari / iOS 只认 hvc1 标签的 H.265
          ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
          ...audioPassthroughArgs(source.media),
          ...MP4_OUTPUT,
          '-y',
          output,
        ],
        { duration },
      );
      return { files: [output], data: { lossless: true, displayRotation: rotation } };
    }

    const filters = [...source.prefilters];
    let width = source.width;
    let height = source.height;
    if (plan.quarterTurns === 1) filters.push('transpose=clock');
    if (plan.quarterTurns === 2) filters.push('hflip', 'vflip');
    if (plan.quarterTurns === 3) filters.push('transpose=cclock');
    if (plan.quarterTurns === 1 || plan.quarterTurns === 3) [width, height] = [height, width];
    if (plan.degrees !== undefined) {
      ({ width, height } = rotatedCanvas(width, height, plan.degrees, p.expand));
      const rad = (plan.degrees * Math.PI) / 180;
      filters.push(
        `rotate=a=${num(rad)}:ow=${width}:oh=${height}:fillcolor=${p.fillColor}:bilinear=1`,
      );
    }
    // 任意角度会扩大画布；90 度倍数也要查，源视频本身就可能超限（如 8192x4320 的 DCI 8K）
    if (!fitsMaxSize(width, height)) throw new Error(maxSizeError('旋转后的画面', width, height));
    filters.push(...flipFilters(plan.flip), 'setsar=1');
    ctx.log(`旋转 ${source.width}x${source.height} → ${width}x${height}：${filters.join(',')}`);
    // 输入的旋转已被 FFmpeg 自动摆正；清掉老式 rotate 标签，避免播放器再转一次
    const output = await encodeVideoFilter(ctx, source, filters, ['-metadata:s:v:0', 'rotate=']);
    return { files: [output], data: { width, height } };
  },
});
