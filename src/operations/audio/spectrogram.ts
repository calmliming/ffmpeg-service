import { z } from 'zod';
import { booleanParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { num, probeAudio, rethrowWith, singleInput } from './format';
import { imageSizeParam } from './waveform';

const COLOR_SCHEMES = [
  'channel',
  'intensity',
  'rainbow',
  'moreland',
  'nebulae',
  'fire',
  'fiery',
  'fruit',
  'cool',
  'magma',
  'green',
  'viridis',
  'plasma',
  'cividis',
  'terrain',
] as const;
const SCALES = ['lin', 'sqrt', 'cbrt', 'log', '4thrt', '5thrt'] as const;
const FREQUENCY_SCALES = ['lin', 'log'] as const;
const MODES = ['combined', 'separate'] as const;

/**
 * showspectrumpic 把整段音频以 32 位浮点缓存在内存里再做 FFT：
 * 上限按 30 分钟 48 kHz 单声道折算成采样点数（约 330 MB）
 */
export const MAX_SPECTRUM_SECONDS = 30 * 60;
const MAX_SPECTRUM_SAMPLES = MAX_SPECTRUM_SECONDS * 48000;

export const spectrogramOperation = defineOperation({
  name: 'audio.spectrogram',
  route: '/api/audio/spectrogram',
  title: '频谱图',
  description: '把整段音频的时频谱（横轴时间、纵轴频率、颜色表示能量）画成一张 PNG 图片。',
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
    size: imageSizeParam('size').default({ width: 1200, height: 600 }).meta({
      description: '频谱区域尺寸 宽x高，默认 1200x600，最大 7680x4320；带图例时整张图会更大',
    }),
    legend: booleanParam('legend')
      .default(true)
      .meta({ description: '是否画坐标轴和图例（时间、频率刻度和色标），默认 true' }),
    colorScheme: enumParam('colorScheme', COLOR_SCHEMES).default('intensity').meta({
      description:
        '配色：intensity（默认）/ rainbow / magma / viridis / plasma / cividis / fire / fiery / nebulae / moreland / fruit / cool / green / terrain / channel（每个声道一种颜色）',
    }),
    scale: enumParam('scale', SCALES)
      .default('log')
      .meta({ description: '能量刻度：log 对数（默认）/ lin / sqrt / cbrt / 4thrt / 5thrt' }),
    frequencyScale: enumParam('frequencyScale', FREQUENCY_SCALES)
      .default('lin')
      .meta({ description: '频率轴刻度：lin 线性（默认）/ log 对数（低频细节更多，适合音乐）' }),
    mode: enumParam('mode', MODES)
      .default('combined')
      .meta({ description: 'combined 所有声道合成一张（默认）/ separate 每个声道单独画' }),
    minFrequency: numberParam('minFrequency', { min: 0, max: 96000, int: true })
      .optional()
      .meta({ description: '显示的最低频率（Hz），默认 0' }),
    maxFrequency: numberParam('maxFrequency', { min: 1, max: 96000, int: true })
      .optional()
      .meta({ description: '显示的最高频率（Hz），默认到采样率的一半；必须大于 minFrequency' }),
    dynamicRange: numberParam('dynamicRange', { min: 10, max: 200 })
      .default(120)
      .meta({ description: '动态范围（dB，10-200），默认 120；调小后弱信号显示更少、对比更强' }),
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/spectrogram -F "file=@song.flac" -F "colorScheme=magma" -F "frequencyScale=log"',
    '',
    'curl -X POST http://localhost:9527/api/audio/spectrogram -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/voice.wav", "size": "1600x800", "maxFrequency": 8000, "legend": false}\'',
  ].join('\n'),
  notes: [
    'legend=false 时图片尺寸与 size 完全一致；legend=true 时四周加上坐标和色标，整张图比 size 大（1200x600 约为 1482x728）',
    `需要把整段音频读进内存，最长 ${MAX_SPECTRUM_SECONDS / 60} 分钟（按 48 kHz 单声道计；mode=separate 或 colorScheme=channel 时按声道数缩短）；combined 模式会先混成单声道以节省内存`,
    'maxFrequency 不能超过输入采样率的一半',
    '图片在整段音频读完后才生成，处理过程中进度不会逐步增长',
  ],
  check(params) {
    if (
      params.minFrequency !== undefined &&
      params.maxFrequency !== undefined &&
      params.maxFrequency <= params.minFrequency
    ) {
      return 'maxFrequency 必须大于 minFrequency';
    }
    return undefined;
  },
  async run(ctx, params) {
    const file = singleInput(ctx);
    const media = await probeAudio(ctx, file);
    const { sampleRate, channels } = media.audio;
    const nyquist = sampleRate / 2;
    if (params.maxFrequency !== undefined && nyquist > 0 && params.maxFrequency > nyquist) {
      throw new Error(
        `maxFrequency（${params.maxFrequency} Hz）超过了输入采样率的一半（${nyquist} Hz）`,
      );
    }
    if (params.minFrequency !== undefined && nyquist > 0 && params.minFrequency >= nyquist) {
      throw new Error(
        `minFrequency（${params.minFrequency} Hz）必须低于输入采样率的一半（${nyquist} Hz）`,
      );
    }

    // 合成一张图时先混成单声道，内存减半；按声道着色或分声道画时必须保留各声道
    const perChannel = params.mode === 'separate' || params.colorScheme === 'channel';
    const keptChannels = perChannel ? Math.max(1, channels) : 1;
    if (!(media.audioDuration > 0)) throw new Error('无法获取音频时长，不能生成频谱图');
    const samples = media.audioDuration * (sampleRate || 48000) * keptChannels;
    if (samples > MAX_SPECTRUM_SAMPLES) {
      const limit = MAX_SPECTRUM_SAMPLES / (sampleRate || 48000) / keptChannels;
      throw new Error(
        `音频太长（${num(media.audioDuration / 60, 1)} 分钟），频谱图需要整段读进内存，当前采样率和声道下最长 ${num(limit / 60, 1)} 分钟`,
      );
    }

    const { width, height } = params.size;
    const opts = [
      `s=${width}x${height}`,
      `mode=${params.mode}`,
      `color=${params.colorScheme}`,
      `scale=${params.scale}`,
      `fscale=${params.frequencyScale}`,
      `legend=${params.legend ? 1 : 0}`,
      `drange=${num(params.dynamicRange, 2)}`,
    ];
    if (params.minFrequency !== undefined) opts.push(`start=${params.minFrequency}`);
    if (params.maxFrequency !== undefined) opts.push(`stop=${params.maxFrequency}`);
    const downmix = perChannel ? '' : 'aformat=channel_layouts=mono,';
    const graph = `[0:a:0]${downmix}showspectrumpic=${opts.join(':')},format=rgb24[out]`;

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
      .catch(rethrowWith(ctx, '生成频谱图失败'));
    // 带图例时整张图比 size 大，返回实际尺寸
    const image = await ctx.probe(output).catch(() => undefined);
    return {
      files: [output],
      data: {
        width: image?.video?.width ?? width,
        height: image?.video?.height ?? height,
        legend: params.legend,
      },
    };
  },
});
