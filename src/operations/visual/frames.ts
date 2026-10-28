import path from 'path';
import { z } from 'zod';
import { numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  assertFrames,
  extractFrameSeries,
  formatSeconds,
  imageFormatParam,
  probeVideo,
  qualityParam,
  round3,
  widthFilters,
  widthParam,
} from './shared';

const MAX_FRAMES = 500;

const params = z.object({
  fps: numberParam('fps', { min: 0.001, max: 120 }).optional().meta({
    description:
      '每秒抽几帧（0.001-120），如 1 表示每秒一帧；fps、interval、count 三选一，都不传时为 1',
  }),
  interval: numberParam('interval', { min: 0.01, max: 3600 })
    .optional()
    .meta({ description: '每隔多少秒抽一帧（0.01-3600）' }),
  count: numberParam('count', { min: 1, max: MAX_FRAMES, int: true })
    .optional()
    .meta({ description: `在时间范围内均匀抽取的帧数 1-${MAX_FRAMES}` }),
  startTime: timeParam('startTime')
    .optional()
    .meta({ description: '开始时间（秒或 HH:MM:SS），默认 0' }),
  endTime: timeParam('endTime')
    .optional()
    .meta({ description: '结束时间（秒或 HH:MM:SS），默认到视频结尾' }),
  width: widthParam('图片宽度（像素），高度按比例；不传则为原始分辨率'),
  format: imageFormatParam('jpg'),
  quality: qualityParam(90),
});

export const frames = defineOperation({
  name: 'video.frames',
  route: '/api/video/frames',
  title: '批量抽帧',
  description: '按帧率、固定间隔或总数从视频（或其中一段）中批量抽取画面，输出一组图片。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '视频文件' }],
  params,
  example: [
    '# 第 10-40 秒每 2 秒一帧，缩放到 480 宽',
    'curl -X POST http://localhost:9527/api/video/frames \\',
    '  -F "file=@video.mp4" \\',
    '  -F "interval=2" \\',
    '  -F "startTime=10" -F "endTime=40" \\',
    '  -F "width=480"',
    '',
    '# 用 URL 提交，整个视频均匀抽 20 帧',
    'curl -X POST http://localhost:9527/api/video/frames \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","count":20,"format":"webp"}\'',
  ].join('\n'),
  notes: [
    `最多 ${MAX_FRAMES} 帧：按 fps / interval 计算出的帧数超过上限时任务失败，请降低 fps、增大 interval 或缩短时间范围`,
    'fps / interval 模式从 startTime 开始取第一帧；count 模式把时间范围等分成 count 段，取每段的中点',
    '每张图是 result.data.frames[].time 处或之后的第一帧；MPEG-TS（.ts / .mts / .m2ts）等没有索引的容器同样精确',
    'count 超过时间范围内的实际帧数时按实际帧数输出，result.data.count 是实际张数',
    'width 为 16-7680；按比例算出的高度也不能超过 7680，总像素不超过 7680x4320',
    '产物放在同一个目录，文件名 frame-0001.jpg、frame-0002.jpg……；result.data.frames 给出每张图对应的时间',
    '间隔不小于 5 秒时逐帧跳转截取，长视频也很快；间隔更小时整段解码一遍',
  ],
  check(p) {
    const modes = [p.fps, p.interval, p.count].filter((v) => v !== undefined).length;
    if (modes > 1) return 'fps、interval、count 只能指定其中一个';
    if (p.startTime !== undefined && p.endTime !== undefined && p.endTime <= p.startTime) {
      return '结束时间 endTime 必须大于开始时间 startTime';
    }
    return undefined;
  },
  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await probeVideo(ctx, file, '视频');
    const duration = info.videoDuration;
    const start = p.startTime ?? 0;
    if (start >= duration) {
      throw new Error(
        `开始时间 ${formatSeconds(start)} 秒超出视频画面时长 ${formatSeconds(duration)} 秒`,
      );
    }
    const end = Math.min(p.endTime ?? duration, duration);
    const span = end - start;

    const filters = widthFilters(info, p.width);
    let first = start;
    let step: number;
    let count: number;
    if (p.count !== undefined) {
      // 要的帧数比范围内实际的帧还多时只会得到一堆重复画面，还会退化成逐帧跳转，按实际帧数封顶
      const available = Math.max(1, Math.floor(span * info.fps + 1e-6));
      count = Math.min(p.count, available);
      if (count < p.count) {
        ctx.log(`时间范围内只有约 ${available} 帧，count 从 ${p.count} 降为 ${count}`);
      }
      step = span / count;
      first = start + step / 2;
    } else {
      step = p.interval ?? 1 / (p.fps ?? 1);
      count = Math.floor((span - 1e-6) / step) + 1;
      if (count > MAX_FRAMES) {
        throw new Error(
          `按当前参数会抽取约 ${count} 帧，超过上限 ${MAX_FRAMES} 帧，请降低 fps、增大 interval 或缩短时间范围`,
        );
      }
    }

    const dir = await ctx.outputDir();
    const list = await extractFrameSeries(ctx, file, info, {
      start: first,
      step,
      count,
      filters,
      format: p.format,
      quality: p.quality,
      dir,
      prefix: 'frame',
      range: [0, 1],
    });
    assertFrames(list);
    return {
      files: list.map((f) => path.join(dir, f.file)),
      data: { count: list.length, interval: round3(step), frames: list },
    };
  },
});
