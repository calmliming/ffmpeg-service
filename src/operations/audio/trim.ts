import { z } from 'zod';
import { timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { encodeAudio, num, outputFields, prepareSingle } from './format';

export const trimAudioOperation = defineOperation({
  name: 'audio.trim',
  route: '/api/audio/trim',
  title: '音频裁剪',
  description: '截取音频的一段，按采样点精确裁剪（不受编码帧边界影响）。',
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
    startTime: timeParam('startTime')
      .default(0)
      .meta({ description: '开始时间，秒数（12.5）或 HH:MM:SS(.mmm)（00:01:02.5），默认 0' }),
    endTime: timeParam('endTime')
      .optional()
      .meta({ description: '结束时间，格式同 startTime；与 duration 二选一，都不传时截到结尾' }),
    duration: timeParam('duration')
      .optional()
      .meta({ description: '截取时长，秒数或 HH:MM:SS；与 endTime 二选一' }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/trim -F "file=@song.mp3" -F "startTime=00:00:30" -F "duration=15"',
    '',
    'curl -X POST http://localhost:9527/api/audio/trim -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/podcast.m4a", "startTime": "1:02.5", "endTime": "2:10"}\'',
  ].join('\n'),
  notes: [
    '用 atrim 滤镜从头解码后按采样点裁剪，起止点精确；因为要重新编码，无损格式（wav / flac）之外会有一次有损编码',
    'endTime 或 startTime + duration 超过音频长度时截到结尾；startTime 超过音频长度时任务失败',
  ],
  check(params) {
    if (params.endTime !== undefined && params.duration !== undefined) {
      return 'endTime 和 duration 只能提供其中一个';
    }
    if (params.endTime !== undefined && params.endTime <= params.startTime) {
      return 'endTime 必须大于 startTime';
    }
    if (params.duration !== undefined && params.duration <= 0) return 'duration 必须大于 0';
    if (params.startTime === 0 && params.endTime === undefined && params.duration === undefined) {
      return '请提供 startTime、endTime 或 duration';
    }
    return undefined;
  },
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);
    const total = media.audioDuration;
    const start = params.startTime;
    if (total > 0 && start >= total) {
      throw new Error(`startTime（${num(start, 3)} 秒）超出了音频时长（${num(total, 3)} 秒）`);
    }
    let end =
      params.endTime ?? (params.duration !== undefined ? start + params.duration : undefined);
    if (end !== undefined && total > 0 && end >= total) end = undefined;

    const opts = [`start=${num(start)}`];
    if (end !== undefined) opts.push(`end=${num(end)}`);
    const expected = (end ?? total) - start;

    const output = await encodeAudio(ctx, {
      inputs: [file],
      filter: `atrim=${opts.join(':')},asetpts=PTS-STARTPTS`,
      encode: { format, bitrate: params.bitrate, inputChannels: media.audio.channels },
      duration: expected > 0 ? expected : undefined,
      errorPrefix: '音频裁剪失败',
    });
    return { files: [output], data: { start, end: end ?? null, duration: Math.max(0, expected) } };
  },
});
