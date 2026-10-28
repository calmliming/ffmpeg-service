import { z } from 'zod';
import { enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  FADE_CURVE_NOTE,
  FADE_CURVES,
  encodeAudio,
  num,
  outputFields,
  prepareSingle,
} from './format';

export const fadeOperation = defineOperation({
  name: 'audio.fade',
  route: '/api/audio/fade',
  title: '音频淡入淡出',
  description: '给音频开头加淡入、结尾加淡出，可选淡变曲线。',
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
    fadeIn: numberParam('fadeIn', { min: 0, max: 600 })
      .default(0)
      .meta({ description: '淡入时长（秒，0-600），0 表示不淡入' }),
    fadeOut: numberParam('fadeOut', { min: 0, max: 600 })
      .default(0)
      .meta({ description: '淡出时长（秒，0-600），在结尾处结束，0 表示不淡出' }),
    curve: enumParam('curve', FADE_CURVES)
      .default('tri')
      .meta({ description: `淡变曲线，默认 tri（线性）。${FADE_CURVE_NOTE}` }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/fade -F "file=@song.mp3" -F "fadeIn=2" -F "fadeOut=5"',
    '',
    'curl -X POST http://localhost:9527/api/audio/fade -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/bgm.m4a", "fadeOut": 3, "curve": "qsin"}\'',
  ].join('\n'),
  notes: [
    'fadeIn 和 fadeOut 至少设置一个；两者之和不能超过音频时长',
    '淡出起点按探测到的时长计算，时长无法获取时不能淡出',
  ],
  check(params) {
    if (params.fadeIn <= 0 && params.fadeOut <= 0) return '请设置 fadeIn 或 fadeOut（秒）';
    return undefined;
  },
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);
    const duration = media.audioDuration;
    if (params.fadeOut > 0 && !(duration > 0)) {
      throw new Error('无法获取音频时长，不能设置淡出');
    }
    if (duration > 0 && params.fadeIn + params.fadeOut > duration + 0.001) {
      throw new Error(
        `淡入加淡出共 ${num(params.fadeIn + params.fadeOut, 3)} 秒，超过了音频时长 ${num(duration, 3)} 秒`,
      );
    }

    const filters: string[] = [];
    if (params.fadeIn > 0) {
      filters.push(`afade=t=in:st=0:d=${num(params.fadeIn)}:curve=${params.curve}`);
    }
    if (params.fadeOut > 0) {
      const start = Math.max(0, duration - params.fadeOut);
      filters.push(`afade=t=out:st=${num(start)}:d=${num(params.fadeOut)}:curve=${params.curve}`);
    }

    const output = await encodeAudio(ctx, {
      inputs: [file],
      filter: filters.join(','),
      encode: { format, bitrate: params.bitrate, inputChannels: media.audio.channels },
      duration,
      errorPrefix: '淡入淡出处理失败',
    });
    return { files: [output] };
  },
});
