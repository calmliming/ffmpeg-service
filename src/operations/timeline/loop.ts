import fs from 'fs';
import { z } from 'zod';
import { concatListContent } from '../../services/compose.service';
import { enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AUDIO_ENCODE,
  FASTSTART,
  VIDEO_ENCODE,
  copyContainer,
  evenSizeFilters,
  fmtSec,
  probeInput,
  reencodeExt,
  sec,
  streamMaps,
} from './shared';

export const MAX_LOOP_SECONDS = 3600;
/** 素材极短、目标很长时列表会非常长，限制总循环次数 */
const MAX_LOOPS = 10000;

export const loopOperation = defineOperation({
  name: 'video.loop',
  route: '/api/video/loop',
  title: '循环播放',
  description:
    '把视频或音频首尾相接重复多次：指定重复次数 times，或指定目标时长 duration（最后一遍在目标时长处截断）。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '视频或音频文件' }],
  params: z.object({
    times: numberParam('times', { min: 2, max: 100, int: true }).optional().meta({
      description: '重复次数（含原片），2-100 的整数。times 和 duration 二选一，都不填时为 2',
    }),
    duration: timeParam('duration')
      .refine((value) => value > 0 && value <= MAX_LOOP_SECONDS, {
        error: `duration 必须大于 0 且不超过 ${MAX_LOOP_SECONDS} 秒（1 小时）`,
      })
      .optional()
      .meta({
        description:
          '目标总时长，秒数或 HH:MM:SS，最长 1 小时。素材会一直循环直到这个时长，最后一遍在此截断',
      }),
    mode: enumParam('mode', ['accurate', 'fast']).default('accurate').meta({
      description:
        'accurate（默认）重新编码，输出统一的 MP4 / M4A；fast 直接流复制，速度快、画质无损，容器按原编码选择（MP4 放不下时为 MKV）',
    }),
  }),
  chainable: true,
  check(params) {
    if (params.times !== undefined && params.duration !== undefined) {
      return 'times 和 duration 只能二选一';
    }
    return undefined;
  },
  example: [
    'curl -X POST http://localhost:9527/api/video/loop \\',
    '  -F "file=@clip.mp4" \\',
    '  -F "times=5"',
    '',
    '# 循环到 1 分钟，流复制',
    'curl -X POST http://localhost:9527/api/video/loop \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/clip.mp4","duration":60,"mode":"fast"}\'',
  ].join('\n'),
  notes: [
    `输出总时长上限 ${MAX_LOOP_SECONDS / 3600} 小时（times × 原时长，或 duration）。`,
    'duration 小于原时长时相当于从头截取到该时长。',
    '用 concat 列表重复同一个文件，每一遍的起点严格等于原文件时长；accurate 模式会给声音比画面短的素材补静音，不会逐遍累积音画错位。',
    'mode=fast 不重新编码，截断点落在最近的数据包上；声音明显短于画面的素材用 fast 循环多遍后可能音画不同步，请用 accurate。',
  ],
  async run(ctx, params) {
    const input = ctx.inputs.file[0];
    const media = await probeInput(ctx, input);
    const period = media.duration;
    const target = params.duration ?? (params.times ?? 2) * period;
    if (target > MAX_LOOP_SECONDS + 1e-6) {
      throw new Error(
        `循环后总时长 ${fmtSec(target)} 秒超过上限 ${MAX_LOOP_SECONDS / 3600} 小时，请减少 times`,
      );
    }
    const loops = Math.max(1, Math.ceil(target / period - 1e-6));
    if (loops > MAX_LOOPS) {
      throw new Error(
        `素材只有 ${fmtSec(period)} 秒，循环到目标时长需要 ${loops} 遍，超过上限 ${MAX_LOOPS} 遍`,
      );
    }

    // concat 列表比 -stream_loop 精确：stream_loop 每一遍的时间偏移略小于文件时长（实测 2 秒素材每遍少约 12 毫秒），循环多了画面会丢帧
    const list = ctx.tempPath('loop.ffconcat');
    await fs.promises.writeFile(
      list,
      concatListContent(Array.from({ length: loops }, () => input)),
    );

    const args = ['-f', 'concat', '-safe', '0', '-i', list, ...streamMaps(media)];
    let ext: string;
    if (params.mode === 'fast') {
      const container = copyContainer(media);
      ext = container.ext;
      args.push('-c', 'copy', ...container.extraArgs);
      if (container.movflags) args.push(...FASTSTART);
    } else {
      ext = reencodeExt(media);
      if (media.video) {
        const filters = evenSizeFilters(media);
        if (filters.length > 0) args.push('-vf', filters.join(','));
        args.push(...VIDEO_ENCODE);
      }
      // 声音比画面短时每一遍之间有时间戳空洞，编码器不会自己补，不补静音的话声音会逐遍提前
      if (media.audio) args.push('-af', 'aresample=async=1:first_pts=0', ...AUDIO_ENCODE);
      args.push(...FASTSTART);
    }
    const output = ctx.outputPath(ext);
    args.push('-t', sec(target), '-y', output);

    ctx.progress(0, { phase: 'processing' });
    await ctx.ffmpeg(args, { duration: target });
    return {
      files: [output],
      data: { loops, duration: Number(target.toFixed(3)) },
    };
  },
});
