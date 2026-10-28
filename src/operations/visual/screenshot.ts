import path from 'path';
import { z } from 'zod';
import { parseTime, toList } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  formatSeconds,
  grabFrame,
  imageFormatParam,
  lastFrameTime,
  probeVideo,
  qualityParam,
  round3,
  widthFilters,
  widthParam,
} from './shared';

const MAX_TIMESTAMPS = 50;
const MISSING = '请提供 timestamps 参数（逗号分隔）';

/** 时间点：秒数、HH:MM:SS，或百分比（50% 表示视频中点，fluent-ffmpeg 时代就支持的写法） */
export type TimePoint = { seconds: number } | { percent: number };

function parseTimePoint(value: unknown): TimePoint | undefined {
  if (typeof value === 'string') {
    const match = /^\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/.exec(value);
    if (match) {
      const percent = Number(match[1]);
      return percent <= 100 ? { percent } : undefined;
    }
  }
  const seconds = parseTime(value);
  return seconds === undefined ? undefined : { seconds };
}

const timestamps = z.preprocess(
  toList,
  z
    .array(z.union([z.string(), z.number()]), {
      error: (issue) =>
        issue.input === undefined ? MISSING : 'timestamps 必须是逗号分隔的时间列表或数组',
    })
    .min(1, { error: MISSING })
    .max(MAX_TIMESTAMPS, { error: `timestamps 最多 ${MAX_TIMESTAMPS} 个时间点` })
    .transform((items, ctx) => {
      const points: TimePoint[] = [];
      for (const item of items) {
        const point = parseTimePoint(item);
        if (!point) {
          const shown = String(item).slice(0, 32);
          ctx.issues.push({
            code: 'custom',
            input: item,
            message: `timestamps 中的「${shown}」不是有效的时间（秒数、HH:MM:SS 或 0-100%）`,
          });
          return z.NEVER;
        }
        points.push(point);
      }
      return points;
    }),
);

const params = z.object({
  timestamps: timestamps.meta({
    description: `截图时间点，逗号分隔或数组；每项可以是秒数（12.5）、HH:MM:SS（00:01:05）或百分比（50%），最多 ${MAX_TIMESTAMPS} 个`,
  }),
  format: imageFormatParam('png'),
  quality: qualityParam(90),
  width: widthParam('截图宽度（像素），高度按比例；不传则为原始分辨率'),
});

export const screenshot = defineOperation({
  name: 'screenshot',
  route: '/api/process/screenshot',
  title: '视频截图',
  description: '在指定的时间点截取视频画面，每个时间点输出一张图片，顺序与请求一致。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '视频文件' }],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/process/screenshot \\',
    '  -F "file=@video.mp4" \\',
    '  -F "timestamps=00:00:02,5.5,50%" \\',
    '  -F "format=jpg" \\',
    '  -F "width=640"',
    '',
    '# 用 URL 提交',
    'curl -X POST http://localhost:9527/api/process/screenshot \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","timestamps":["00:00:02","00:00:05"]}\'',
  ].join('\n'),
  notes: [
    `最多 ${MAX_TIMESTAMPS} 个时间点，可以重复；时间点超出视频画面时长时任务失败并说明原因`,
    '时间点正好等于时长（或 100%）时取最后一帧',
    '截图是精确到帧的（取时间点处或之后的第一帧）：先跳到前一个关键帧再解码到目标时间，长视频也很快；MPEG-TS（.ts / .mts / .m2ts）等没有索引的容器先跳到目标之前再精确选帧，比 mp4 稍慢',
    '每个时间点一个独立文件（随机文件名，与旧版一样直接放在输出目录），files 的顺序与请求一致；result.data.frames 给出每张图对应的时间和文件名',
    '变形宽银幕（像素不是正方形）的视频会先按显示比例拉正；手机竖拍视频按旋转后的方向输出',
    'width 为 16-7680；按比例算出的高度也不能超过 7680，总像素不超过 7680x4320',
  ],
  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await probeVideo(ctx, file, '视频');
    const times = p.timestamps.map((point) =>
      'percent' in point ? (info.videoDuration * point.percent) / 100 : point.seconds,
    );
    times.forEach((time) => {
      if (time > info.videoDuration + 0.001) {
        throw new Error(
          `时间点 ${formatSeconds(time)} 秒超出视频画面时长 ${formatSeconds(info.videoDuration)} 秒`,
        );
      }
    });

    const filters = widthFilters(info, p.width);
    const last = lastFrameTime(info);
    const files: string[] = [];
    const frames: { time: number; file: string }[] = [];
    for (let i = 0; i < times.length; i++) {
      // 与旧版一样每张图是输出目录顶层的独立文件、文件名全局唯一：SAVE_OUTPUT_FILE=false 时下载后能逐个删除，
      // 旧客户端用 output 的文件名拼 /api/files/<文件名> 也能下载
      const out = ctx.outputPath(p.format);
      const time = await grabFrame(ctx, file, info, {
        time: Math.min(times[i], last),
        filters,
        format: p.format,
        quality: p.quality,
        out,
        range: [i / times.length, (i + 1) / times.length],
      });
      files.push(out);
      frames.push({ time: round3(time), file: path.basename(out) });
    }
    return { files, data: { frames } };
  },
});
