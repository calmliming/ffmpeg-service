import { z } from 'zod';
import { booleanParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { encodeAudio, num, outputFields, prepareSingle } from './format';

/** 限幅器：峰值压到约 -0.26 dBFS；level=0 关掉自动电平，latency=1 补偿前瞻延迟，声音不会整体后移 */
export const LIMITER = 'alimiter=limit=0.97:level=0:latency=1';

export const volumeOperation = defineOperation({
  name: 'audio.volume',
  route: '/api/audio/volume',
  title: '调整音量',
  description: '按分贝或倍数放大、减小音量，放大时默认加限幅器防止削波失真。',
  inputs: [
    {
      name: 'file',
      kind: 'media',
      required: true,
      description: '音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频）',
    },
  ],
  chainable: true,
  params: z.object({
    gain: numberParam('gain', { min: -60, max: 60 }).optional().meta({
      description:
        '增益（dB，-60 到 60），正数放大、负数减小，如 6 约等于音量翻倍。与 factor 二选一',
    }),
    factor: numberParam('factor', { min: 0, max: 10 }).optional().meta({
      description: '音量倍数（0-10），1 为原音量、0.5 减半、2 放大一倍、0 静音。与 gain 二选一',
    }),
    limiter: booleanParam('limiter')
      .optional()
      .meta({ description: '是否加限幅器防止削波，默认放大时开启、减小时关闭' }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/volume -F "file=@quiet.mp3" -F "gain=6"',
    '',
    'curl -X POST http://localhost:9527/api/audio/volume -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/loud.wav", "factor": 0.5}\'',
  ].join('\n'),
  notes: [
    'gain 和 factor 必须且只能提供一个',
    '限幅器把峰值压在约 -0.26 dBFS 以下，避免放大后爆音；想要可预测的统一响度请用 /api/audio/normalize',
  ],
  check(params) {
    if (params.gain === undefined && params.factor === undefined)
      return '请提供 gain（分贝）或 factor（倍数）';
    if (params.gain !== undefined && params.factor !== undefined)
      return 'gain 和 factor 只能提供其中一个';
    return undefined;
  },
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);
    const boost = (params.gain ?? 0) > 0 || (params.factor ?? 1) > 1;
    const limiter = params.limiter ?? boost;
    const volume =
      params.gain !== undefined
        ? `volume=${num(params.gain, 3)}dB`
        : `volume=${num(params.factor ?? 1, 4)}`;
    const filter = limiter ? `${volume},${LIMITER}` : volume;

    const output = await encodeAudio(ctx, {
      inputs: [file],
      filter,
      encode: { format, bitrate: params.bitrate, inputChannels: media.audio.channels },
      duration: media.audioDuration,
      errorPrefix: '调整音量失败',
    });
    return {
      files: [output],
      data: { gain: params.gain ?? null, factor: params.factor ?? null, limiter },
    };
  },
});
