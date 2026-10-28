import { z } from 'zod';
import { defineOperation } from '../types';
import { encodeAudio, num, outputFields, prepareSingle } from './format';

/** areverse 要把整段音频缓存在内存里：上限按 30 分钟 48 kHz 立体声折算成采样点数（16 位约 330 MB） */
export const MAX_REVERSE_SECONDS = 30 * 60;
const MAX_REVERSE_SAMPLES = MAX_REVERSE_SECONDS * 48000 * 2;

/** 按时长、采样率、声道数判断能不能倒放，超出内存预算时返回中文错误信息 */
export function reverseLimitProblem(
  duration: number,
  sampleRate: number,
  channels: number,
): string | undefined {
  if (!(duration > 0)) return '无法获取音频时长，不能倒放';
  const rate = sampleRate > 0 ? sampleRate : 48000;
  const perSecond = rate * Math.max(1, channels);
  if (duration * perSecond <= MAX_REVERSE_SAMPLES) return undefined;
  const limit = MAX_REVERSE_SAMPLES / perSecond;
  return `音频太长（${num(duration / 60, 1)} 分钟），倒放需要整段读进内存，当前采样率和声道下最长 ${num(limit / 60, 1)} 分钟`;
}

export const reverseOperation = defineOperation({
  name: 'audio.reverse',
  route: '/api/audio/reverse',
  title: '音频倒放',
  description: '把音频从尾到头倒着播放。',
  inputs: [
    {
      name: 'file',
      kind: 'media',
      required: true,
      description: '音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频）',
    },
  ],
  chainable: true,
  params: z.object({ ...outputFields }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/reverse -F "file=@sample.wav"',
    '',
    'curl -X POST http://localhost:9527/api/audio/reverse -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/sfx.mp3", "format": "ogg"}\'',
  ].join('\n'),
  notes: [
    `倒放需要把整段音频读进内存，最长 ${MAX_REVERSE_SECONDS / 60} 分钟（按 48 kHz 立体声计；采样率更高或声道更多时相应缩短），超过时任务失败`,
    '内部以 16 位精度缓存以减少内存占用',
  ],
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);
    const { sampleRate, channels } = media.audio;
    const problem = reverseLimitProblem(media.audioDuration, sampleRate, channels);
    if (problem) throw new Error(problem);

    const output = await encodeAudio(ctx, {
      inputs: [file],
      // 解码出来多是 32 位浮点，先转 16 位再缓存，内存减半
      filter: 'aformat=sample_fmts=s16p,areverse',
      encode: { format, bitrate: params.bitrate, inputChannels: channels },
      duration: media.audioDuration,
      errorPrefix: '音频倒放失败',
    });
    return { files: [output] };
  },
});
