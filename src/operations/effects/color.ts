import { z } from 'zod';
import { enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  VIDEO_INPUT,
  assertFrameSize,
  assertStartInside,
  checkTimeWindow,
  enableExpr,
  filterChainArgs,
  inspectVideo,
  num,
  withEnable,
} from './shared';

const PRESETS = [
  'none',
  'grayscale',
  'sepia',
  'negate',
  'vintage',
  'warm',
  'cool',
  'vivid',
  'crossprocess',
  'lighter',
  'darker',
  'contrast',
] as const;
type Preset = (typeof PRESETS)[number];

// 预设全部由固定字符串组成，不含用户输入
const PRESET_FILTERS: Record<Exclude<Preset, 'none'>, string> = {
  grayscale: 'hue=s=0',
  // 经典的棕褐色矩阵（RGB 混合）
  sepia:
    'colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131',
  negate: 'negate',
  vintage: 'curves=preset=vintage',
  // 白平衡色温（默认 6500K），pl=1 保持亮度不变；colorbalance 在中性灰上几乎看不出变化
  warm: 'colortemperature=temperature=5000:pl=1',
  cool: 'colortemperature=temperature=9000:pl=1',
  vivid: 'vibrance=intensity=0.4',
  crossprocess: 'curves=preset=cross_process',
  lighter: 'curves=preset=lighter',
  darker: 'curves=preset=darker',
  contrast: 'curves=preset=strong_contrast',
};

const params = z.object({
  brightness: numberParam('brightness', { min: -1, max: 1 })
    .optional()
    .meta({ description: '亮度 -1 到 1，0 为不变' }),
  contrast: numberParam('contrast', { min: 0, max: 3 })
    .optional()
    .meta({ description: '对比度 0 到 3，1 为不变' }),
  saturation: numberParam('saturation', { min: 0, max: 3 })
    .optional()
    .meta({ description: '饱和度 0 到 3，1 为不变，0 为黑白' }),
  gamma: numberParam('gamma', { min: 0.1, max: 10 })
    .optional()
    .meta({ description: '伽马 0.1 到 10，1 为不变；大于 1 提亮暗部' }),
  hue: numberParam('hue', { min: -180, max: 180 })
    .optional()
    .meta({ description: '色相旋转角度 -180 到 180，0 为不变' }),
  preset: enumParam('preset', PRESETS)
    .default('none')
    .meta({
      description:
        '风格预设：none（默认）、grayscale 黑白、sepia 怀旧棕、negate 负片、vintage 复古、warm 暖色、cool 冷色、' +
        'vivid 鲜艳、crossprocess 交叉冲印、lighter 提亮、darker 压暗、contrast 强对比',
    }),
  startTime: timeParam('startTime')
    .optional()
    .meta({ description: '从第几秒开始调色，秒数或 HH:MM:SS；不传则从头开始' }),
  endTime: timeParam('endTime')
    .optional()
    .meta({ description: '调色到第几秒，秒数或 HH:MM:SS；不传则到结尾' }),
});

type ColorParams = z.output<typeof params>;

/** 调色滤镜链：先套预设，再在预设效果上做亮度 / 对比度等微调 */
export function colorFilters(p: ColorParams): string[] {
  const filters: string[] = [];
  if (p.preset !== 'none') filters.push(PRESET_FILTERS[p.preset]);
  const eq: string[] = [];
  if (p.brightness !== undefined && p.brightness !== 0) eq.push(`brightness=${num(p.brightness)}`);
  if (p.contrast !== undefined && p.contrast !== 1) eq.push(`contrast=${num(p.contrast)}`);
  if (p.saturation !== undefined && p.saturation !== 1) eq.push(`saturation=${num(p.saturation)}`);
  if (p.gamma !== undefined && p.gamma !== 1) eq.push(`gamma=${num(p.gamma)}`);
  if (eq.length > 0) filters.push(`eq=${eq.join(':')}`);
  if (p.hue !== undefined && p.hue !== 0) filters.push(`hue=h=${num(p.hue)}`);
  return filters;
}

export const color = defineOperation({
  name: 'video.color',
  route: '/api/video/color',
  title: '调色 / 滤镜',
  description: '调整视频的亮度、对比度、饱和度、伽马和色相，或套用黑白、复古、暖色等风格预设。',
  inputs: VIDEO_INPUT,
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/color \\',
    '  -F "file=@input.mp4" \\',
    '  -F "brightness=0.05" -F "contrast=1.2" -F "saturation=1.3"',
    '',
    '# 只把第 3-6 秒变成黑白',
    'curl -X POST http://localhost:9527/api/video/color \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","preset":"grayscale","startTime":3,"endTime":6}\'',
  ].join('\n'),
  notes: [
    '至少要有一项调整（非默认值的 brightness / contrast / saturation / gamma / hue，或 preset 不为 none）。',
    '先应用 preset，再在预设效果上做亮度、对比度、饱和度、伽马和色相微调。',
    'startTime / endTime 限定调色生效的时间段，其余时间保持原样。',
    '画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。',
  ],
  check(p) {
    if (colorFilters(p).length === 0) {
      return '至少需要一项调整：brightness、contrast、saturation、gamma、hue 或 preset（全部是默认值时画面不会有任何变化）';
    }
    return checkTimeWindow(p.startTime, p.endTime);
  },
  async run(ctx, p) {
    const input = await inspectVideo(ctx, ctx.inputs.file[0]);
    assertFrameSize(input);
    assertStartInside(p.startTime, input.duration);
    const enable = enableExpr(p.startTime, p.endTime);
    const filters = colorFilters(p).map((f) => withEnable(f, enable));
    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(filterChainArgs(input, filters, output), { duration: input.duration });
    return { files: [output] };
  },
});
