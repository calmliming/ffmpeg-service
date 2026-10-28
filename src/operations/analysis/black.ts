import { z } from 'zod';
import { numberParam } from '../../schemas/coerce';
import { decodedDuration } from '../audio/format';
import { defineOperation } from '../types';
import {
  MAX_INTERVALS,
  filterLogLines,
  fileInput,
  makeInterval,
  num,
  probeInput,
  round,
  totalDuration,
  videoFps,
  type Interval,
} from './shared';

const params = z.object({
  minDuration: numberParam('minDuration', { min: 0.01, max: 3600 })
    .default(0.5)
    .meta({ description: '最短黑场时长（秒），短于它的不计入，默认 0.5' }),
  pixelThreshold: numberParam('pixelThreshold', { min: 0, max: 1 })
    .default(0.1)
    .meta({ description: '像素亮度低于多少（0-1）算黑，默认 0.1；画面偏灰的黑场可以调高到 0.15' }),
  pictureThreshold: numberParam('pictureThreshold', { min: 0, max: 1 }).default(0.98).meta({
    description: '一帧里黑像素占比达到多少（0-1）算黑场，默认 0.98；带台标的黑场可以调低到 0.9',
  }),
});

/**
 * 解析 blackdetect 日志：black_start:0 black_end:1 black_duration:1。
 * 视频在黑场中结束时 black_end 是最后一帧的起点，补上最后一帧的时长对齐到视频结尾
 */
export function parseBlacks(stderr: string, duration: number, fps: number): Interval[] {
  const result: Interval[] = [];
  const frame = fps > 0 ? 1 / fps : 0.04;
  for (const line of filterLogLines(stderr, 'blackdetect')) {
    const m = /^black_start:\s*(-?\d+(?:\.\d+)?)\s+black_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (!m) continue;
    let end = Number(m[2]);
    if (duration > 0 && end < duration && duration - end <= frame * 1.5) end = duration;
    result.push(makeInterval(Number(m[1]), end));
  }
  return result;
}

export const black = defineOperation({
  name: 'analyze.black',
  route: '/api/analyze/black',
  title: '黑场检测',
  description: '找出视频里的黑场片段（片头片尾、转场、广告插入点），返回每段的起止时间。',
  inputs: [fileInput('video', '要分析的视频')],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/analyze/black \\',
    '  -F "file=@input.mp4" -F "minDuration=0.2"',
    '',
    '# URL 输入',
    'curl -X POST http://localhost:9527/api/analyze/black \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","pixelThreshold":0.12}\'',
  ].join('\n'),
  notes: [
    '结果：intervals（黑场区间 [{ start, end, duration }]，秒）、count、totalBlack（黑场总时长）。',
    `区间最多返回 ${MAX_INTERVALS} 条，超过时 truncated 为 true。只分析第一路画面，没有画面的文件直接失败。`,
    '没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录屏）按实际解码长度计算 duration。',
  ],
  async run(ctx, p) {
    const media = await probeInput(ctx, 'video');
    const { stderr } = await ctx.ffmpeg(
      [
        '-i',
        ctx.inputs.file[0],
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        `blackdetect=d=${num(p.minDuration)}:pix_th=${num(p.pixelThreshold)}:pic_th=${num(p.pictureThreshold)}`,
        '-fps_mode',
        'passthrough',
        '-f',
        'null',
        '-',
      ],
      { duration: media.duration, logLevel: 'info', captureStderr: true },
    );
    // 容器里没有时长（管道写出的 webm、浏览器 MediaRecorder 录屏）时用实际解码出的长度
    const decoded = decodedDuration(stderr) ?? 0;
    const duration = Math.max(media.video?.duration || media.duration, decoded);
    const all = parseBlacks(stderr, duration, videoFps(media));
    return {
      files: [],
      data: {
        duration: round(Math.max(media.duration, decoded), 3),
        count: all.length,
        totalBlack: totalDuration(all),
        intervals: all.slice(0, MAX_INTERVALS),
        truncated: all.length > MAX_INTERVALS,
      },
    };
  },
});
