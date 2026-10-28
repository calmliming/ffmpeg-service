import { z } from 'zod';
import { booleanParam, colorParam, enumParam, sizeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { num, probeAudio, rethrowWith, singleInput } from './format';

/** 图片尺寸上限，宽高分别不超过 7680x4320 */
export const MAX_IMAGE = { width: 7680, height: 4320 };

/** 图片尺寸参数：sizeParam 每边允许到 8192，这里再收紧到 7680x4320 */
export function imageSizeParam(name: string) {
  return sizeParam(name).refine((s) => s.width <= MAX_IMAGE.width && s.height <= MAX_IMAGE.height, {
    error: `${name} 最大 ${MAX_IMAGE.width}x${MAX_IMAGE.height}`,
  });
}

/** showwavespic 要缓存整段音频才能画图，超过这个时长直接拒绝 */
export const MAX_WAVEFORM_SECONDS = 3 * 60 * 60;
/** 每个声道缓存的采样点上限（约 10 分钟 48 kHz），更长的音频先降采样再画 */
const WAVEFORM_SAMPLE_BUDGET = 10 * 60 * 48000;

/** 长音频降到多少 Hz 再画，返回 undefined 表示不需要降采样 */
export function waveformRate(duration: number, sampleRate: number): number | undefined {
  if (!(duration > 0) || !(sampleRate > 0)) return undefined;
  const rate = Math.max(2000, Math.floor(WAVEFORM_SAMPLE_BUDGET / duration));
  return rate < sampleRate ? rate : undefined;
}

const MODES = ['combined', 'split'] as const;
const SCALES = ['lin', 'log', 'sqrt', 'cbrt'] as const;
const AMPLITUDES = ['average', 'peak'] as const;

export const waveformOperation = defineOperation({
  name: 'audio.waveform',
  route: '/api/audio/waveform',
  title: '波形图',
  description: '把整段音频的波形画成一张 PNG 图片，可设置尺寸、颜色、背景（或透明）和刻度。',
  inputs: [
    {
      name: 'file',
      kind: 'media',
      required: true,
      description: '音频文件，或带音轨的视频（使用第一条音轨）',
    },
  ],
  chainable: true,
  params: z.object({
    size: imageSizeParam('size')
      .default({ width: 1200, height: 240 })
      .meta({ description: '图片尺寸 宽x高，默认 1200x240，最大 7680x4320' }),
    color: colorParam('color')
      .default('0x3B82F6')
      .meta({ description: '波形颜色：颜色名、#RRGGBB 或 #RRGGBBAA，可带 @透明度，默认 #3B82F6' }),
    backgroundColor: colorParam('backgroundColor')
      .optional()
      .meta({ description: '背景颜色，格式同 color，默认白色；与 transparent 二选一' }),
    transparent: booleanParam('transparent')
      .default(false)
      .meta({ description: '透明背景（PNG 带 alpha 通道），默认 false' }),
    mode: enumParam('mode', MODES)
      .default('combined')
      .meta({ description: 'combined 所有声道画在一起（默认）/ split 每个声道单独一行' }),
    scale: enumParam('scale', SCALES).default('lin').meta({
      description:
        '振幅刻度：lin 线性（默认）/ log 对数 / sqrt 平方根 / cbrt 立方根；后三种让小声部分更明显',
    }),
    amplitude: enumParam('amplitude', AMPLITUDES)
      .default('average')
      .meta({ description: '每列取值方式：average 平均值（默认）/ peak 峰值（波形更饱满）' }),
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/waveform -F "file=@song.mp3" -F "size=1600x200" -F "color=#FF5500" -F "transparent=true"',
    '',
    'curl -X POST http://localhost:9527/api/audio/waveform -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/podcast.m4a", "mode": "split", "backgroundColor": "black", "color": "lime"}\'',
  ].join('\n'),
  notes: [
    '输出 PNG，尺寸与 size 完全一致；transparent=true 时为 RGBA，否则为 RGB',
    `音频最长 ${MAX_WAVEFORM_SECONDS / 3600} 小时；超过约 10 分钟的音频先降采样再画（不影响波形轮廓），控制内存占用`,
    '图片在整段音频读完后才生成，处理过程中进度不会逐步增长',
  ],
  check(params) {
    if (params.transparent && params.backgroundColor)
      return 'transparent 和 backgroundColor 只能设置其中一个';
    return undefined;
  },
  async run(ctx, params) {
    const file = singleInput(ctx);
    const media = await probeAudio(ctx, file);
    if (media.audioDuration > MAX_WAVEFORM_SECONDS) {
      throw new Error(
        `音频太长（${num(media.audioDuration / 3600, 2)} 小时），波形图最长支持 ${MAX_WAVEFORM_SECONDS / 3600} 小时`,
      );
    }
    const { width, height } = params.size;
    // showwavespic 每个声道一个颜色，颜色比声道少时剩下的声道会用默认颜色，所以按声道数重复
    const channels = Math.min(Math.max(1, media.audio.channels), 64);
    const colors = Array.from({ length: channels }, () => params.color).join('|');
    const rate = waveformRate(media.audioDuration, media.audio.sampleRate);

    // draw=full 按原色画；默认的 draw=scale 会把颜色和透明度一起压暗（预乘），叠到背景上发灰
    const draw = [
      ...(rate ? [`aresample=${rate}`] : []),
      `showwavespic=s=${width}x${height}:split_channels=${params.mode === 'split' ? 1 : 0}` +
        `:colors=${colors}:scale=${params.scale}:filter=${params.amplitude}:draw=full`,
    ].join(',');
    let graph: string;
    if (params.transparent) {
      graph = `[0:a:0]${draw},format=rgba[out]`;
    } else {
      const background = params.backgroundColor ?? 'white';
      graph =
        `[0:a:0]${draw}[wave];color=c=${background}:s=${width}x${height}:r=1[bg];` +
        `[bg][wave]overlay=format=auto:shortest=1,format=rgb24[out]`;
    }

    const output = ctx.outputPath('png');
    await ctx
      .ffmpeg([
        '-i',
        file,
        '-filter_complex',
        graph,
        '-map',
        '[out]',
        '-frames:v',
        '1',
        '-c:v',
        'png',
        '-f',
        'image2',
        '-update',
        '1',
        '-y',
        output,
      ])
      .catch(rethrowWith(ctx, '生成波形图失败'));
    return { files: [output], data: { width, height } };
  },
});
