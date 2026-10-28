import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  IMAGE_FORMATS,
  MAX_HEIGHT,
  MAX_WIDTH,
  assertFrames,
  extractFrameSeries,
  formatSeconds,
  probeVideo,
  qualityParam,
  round3,
  singleImageOutput,
  squarePixelFilters,
} from './shared';

const MAX_THUMBS = 1000;
const VTT_NAME = 'thumbnails.vtt';
/** 缩略图抽取占进度的比例，剩下的给拼图 */
const EXTRACT_SHARE = 0.85;

const params = z.object({
  interval: numberParam('interval', { min: 0.1, max: 3600 }).optional().meta({
    description: '相邻缩略图间隔（秒）；不传时自动取 时长/100，限制在 1-60 秒（与 count 二选一）',
  }),
  count: numberParam('count', { min: 1, max: MAX_THUMBS, int: true })
    .optional()
    .meta({
      description: `缩略图总数 1-${MAX_THUMBS}，在整个视频上均匀分布（与 interval 二选一）`,
    }),
  columns: numberParam('columns', { min: 1, max: 20, int: true })
    .default(10)
    .meta({ description: '每行缩略图数 1-20，默认 10' }),
  rows: numberParam('rows', { min: 1, max: 30, int: true })
    .default(10)
    .meta({ description: '每张雪碧图最多几行 1-30，默认 10；超过就拆成多张图' }),
  thumbWidth: numberParam('thumbWidth', { min: 40, max: 640, int: true })
    .default(160)
    .meta({ description: '单个缩略图宽度 40-640 像素，默认 160' }),
  thumbHeight: numberParam('thumbHeight', { min: 20, max: 720, int: true })
    .optional()
    .meta({ description: '单个缩略图高度 20-720 像素；不传时按视频比例计算' }),
  format: enumParam('format', IMAGE_FORMATS)
    .default('jpg')
    .meta({ description: '雪碧图格式：jpg（默认）、png、webp' }),
  quality: qualityParam(80),
});

/** WebVTT 时间戳 HH:MM:SS.mmm */
export function vttTime(value: number): string {
  const ms = Math.max(0, Math.round(value * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

export const sprite = defineOperation({
  name: 'video.sprite',
  route: '/api/video/sprite',
  title: '进度条预览雪碧图',
  description:
    '按固定间隔截取缩略图拼成雪碧图，并生成 WebVTT 缩略图轨道，可直接用于 Video.js、Plyr、JW Player 等播放器的进度条悬停预览。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '视频文件' }],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/video/sprite \\',
    '  -F "file=@video.mp4" \\',
    '  -F "interval=5" \\',
    '  -F "columns=10" \\',
    '  -F "thumbWidth=160"',
    '',
    '# 用 URL 提交，固定生成 100 张缩略图',
    'curl -X POST http://localhost:9527/api/video/sprite \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","count":100,"format":"webp"}\'',
  ].join('\n'),
  notes: [
    `最多 ${MAX_THUMBS} 张缩略图；指定的 interval 会超过上限时任务失败，自动间隔时会自动放大间隔`,
    `每张雪碧图宽 columns × thumbWidth 不超过 ${MAX_WIDTH} 像素，高度不超过 ${MAX_HEIGHT} 像素（缩略图很高时自动减少每张的行数）`,
    `产物是一个目录：${VTT_NAME}（主产物）和 sprite-1.jpg、sprite-2.jpg……，vtt 里用相对文件名加 #xywh=x,y,w,h 引用，三者放在同一路径下即可直接使用`,
    'result.data 给出 interval、columns、rows（每张最多行数）、thumbWidth、thumbHeight、count（缩略图总数）、sheets（雪碧图文件名）',
    '间隔不小于 5 秒时逐张跳转截取，长视频也很快；间隔更小时整段解码一遍。每个缩略图是对应 VTT 时间段开头处或之后的第一帧',
  ],
  check(p) {
    if (p.interval !== undefined && p.count !== undefined) return 'interval 和 count 只能指定一个';
    if (p.columns * p.thumbWidth > MAX_WIDTH) {
      return `每张雪碧图宽度 columns × thumbWidth 不能超过 ${MAX_WIDTH} 像素`;
    }
    return undefined;
  },
  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await probeVideo(ctx, file, '视频');
    const duration = info.videoDuration;

    let interval: number;
    let count: number;
    if (p.count !== undefined) {
      count = p.count;
      interval = duration / count;
    } else {
      interval = p.interval ?? Math.min(60, Math.max(1, duration / 100));
      count = Math.max(1, Math.ceil(duration / interval - 1e-6));
      if (count > MAX_THUMBS) {
        if (p.interval !== undefined) {
          throw new Error(
            `按 interval=${formatSeconds(interval)} 秒会生成 ${count} 张缩略图，超过上限 ${MAX_THUMBS} 张，请增大 interval`,
          );
        }
        interval = duration / MAX_THUMBS;
        count = MAX_THUMBS;
      }
    }

    const thumbWidth = p.thumbWidth;
    const thumbHeight =
      p.thumbHeight ?? Math.max(2, Math.round((thumbWidth * info.height) / info.width / 2) * 2);
    if (thumbHeight > MAX_HEIGHT) {
      throw new Error(`视频画面过于狭长，缩略图高度 ${thumbHeight} 超过 ${MAX_HEIGHT} 像素`);
    }

    const frames = await extractFrameSeries(ctx, file, info, {
      start: 0,
      step: interval,
      count,
      filters: [...squarePixelFilters(info), `scale=${thumbWidth}:${thumbHeight}`, 'setsar=1'],
      format: 'png',
      quality: 100,
      dir: ctx.workDir,
      prefix: 'thumb',
      range: [0, EXTRACT_SHARE],
    });
    assertFrames(frames);

    const total = frames.length;
    const columns = Math.min(p.columns, total);
    const rows = Math.max(1, Math.min(p.rows, Math.floor(MAX_HEIGHT / thumbHeight)));
    const perSheet = columns * rows;
    const sheetCount = Math.ceil(total / perSheet);
    const dir = await ctx.outputDir();
    const sheets: string[] = [];

    for (let s = 0; s < sheetCount; s++) {
      const inSheet = Math.min(perSheet, total - s * perSheet);
      const name = `sprite-${s + 1}.${p.format}`;
      const share = (1 - EXTRACT_SHARE) / sheetCount;
      // tile 收满 nb_frames 张就输出，最后一张图不满一行时空位留黑
      await ctx.ffmpeg(
        [
          '-framerate',
          '1',
          '-start_number',
          String(s * perSheet + 1),
          '-i',
          path.join(ctx.workDir, 'thumb-%04d.png'),
          '-vf',
          `tile=${columns}x${Math.ceil(inSheet / columns)}:nb_frames=${inSheet}`,
          ...singleImageOutput(p.format, p.quality, path.join(dir, name)),
        ],
        { range: [EXTRACT_SHARE + s * share, EXTRACT_SHARE + (s + 1) * share] },
      );
      sheets.push(name);
    }

    const cues = frames.map((_, i) => {
      const start = i * interval;
      const end = i === total - 1 ? Math.max(duration, start + 0.001) : (i + 1) * interval;
      const index = i % perSheet;
      const x = (index % columns) * thumbWidth;
      const y = Math.floor(index / columns) * thumbHeight;
      const sheet = sheets[Math.floor(i / perSheet)];
      return `${vttTime(start)} --> ${vttTime(end)}\n${sheet}#xywh=${x},${y},${thumbWidth},${thumbHeight}`;
    });
    const vtt = path.join(dir, VTT_NAME);
    await fs.promises.writeFile(vtt, `WEBVTT\n\n${cues.join('\n\n')}\n`, 'utf8');

    return {
      files: [vtt, ...sheets.map((name) => path.join(dir, name))],
      primary: vtt,
      data: {
        interval: round3(interval),
        columns,
        rows,
        thumbWidth,
        thumbHeight,
        count: total,
        sheets,
        vtt: VTT_NAME,
      },
    };
  },
});
