import path from 'path';
import { z } from 'zod';
import { colorParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  FIT_MODES,
  assertOutputSize,
  extractFrameSeries,
  fitFilters,
  imageFormatParam,
  moveFile,
  probeVideo,
  qualityParam,
  squarePixelFilters,
  thumbOutputSize,
  thumbSizeParam,
} from './shared';

const MAX_COUNT = 50;

const params = z.object({
  count: numberParam('count', { min: 1, max: MAX_COUNT, int: true })
    .default(6)
    .meta({ description: `缩略图数量 1-${MAX_COUNT}，默认 6` }),
  size: thumbSizeParam('size').default({ width: 320, height: 240 }).meta({
    description:
      '缩略图尺寸 宽x高，默认 320x240；只给一边（320x? 或 ?x240）时另一边按比例；也可以是原尺寸的百分比（如 50%）',
  }),
  fit: enumParam('fit', FIT_MODES).default('stretch').meta({
    description:
      '画面比例与 size 不一致时的处理：stretch 拉伸填满（默认，与旧版一致）、contain 完整显示并补边、cover 填满并裁掉多余部分',
  }),
  padColor: colorParam('padColor').default('black').meta({
    description: 'fit=contain 时补边的颜色，默认 black；png / webp 可用 black@0 得到透明边',
  }),
  format: imageFormatParam('png'),
  quality: qualityParam(90),
});

export const thumbnail = defineOperation({
  name: 'thumbnail',
  route: '/api/process/thumbnail',
  title: '生成缩略图',
  description: '从视频中均匀截取多张缩略图，缩放到统一尺寸。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '视频文件' }],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/process/thumbnail \\',
    '  -F "file=@video.mp4" \\',
    '  -F "count=8" \\',
    '  -F "size=640x360" \\',
    '  -F "fit=cover" \\',
    '  -F "format=jpg"',
  ].join('\n'),
  notes: [
    `最多 ${MAX_COUNT} 张；第 i 张取在视频时长的 i/(count+1) 处，避开开头和结尾（与旧版 fluent-ffmpeg 行为一致）`,
    '每边 16-7680 像素，总像素不超过 7680x4320；只给一边或用百分比时，按视频比例算出的另一边也受这个上限约束',
    'size 的写法与旧版（fluent-ffmpeg）相同：640x360、640x?、?x360、50%',
    '每张缩略图一个独立文件（随机文件名，与旧版一样直接放在输出目录），files 按时间先后排列；result.data.frames 给出每张图对应的时间和文件名',
    '每张取在对应时间点处或之后的第一帧；MPEG-TS（.ts / .mts / .m2ts）等没有索引的容器同样精确',
  ],
  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await probeVideo(ctx, file, '视频');
    const output = thumbOutputSize(info, p.size);
    assertOutputSize(output.width, output.height, '缩略图尺寸');
    // 百分比换算成确定的宽高再缩放，表达式里的 iw*0.01 在小画面上会算出 0
    const size = p.size.percent !== undefined ? output : p.size;
    const step = info.videoDuration / (p.count + 1);
    // 先抽到 workDir，再逐张移到输出目录顶层、用随机文件名（与旧版一致）：SAVE_OUTPUT_FILE=false 时下载后能逐个删除，
    // 旧客户端用 output 的文件名拼 /api/files/<文件名> 也能下载
    const extracted = await extractFrameSeries(ctx, file, info, {
      start: step,
      step,
      count: p.count,
      filters: [...squarePixelFilters(info), ...fitFilters(size, p.fit, p.padColor, p.format)],
      format: p.format,
      quality: p.quality,
      dir: ctx.workDir,
      prefix: 'thumbnail',
      range: [0, 1],
    });
    if (extracted.length < p.count) {
      throw new Error(`只取到 ${extracted.length} 张缩略图，少于要求的 ${p.count} 张`);
    }
    const files: string[] = [];
    const frames: { time: number; file: string }[] = [];
    for (const frame of extracted) {
      const out = ctx.outputPath(p.format);
      await moveFile(path.join(ctx.workDir, frame.file), out);
      files.push(out);
      frames.push({ time: frame.time, file: path.basename(out) });
    }
    return { files, data: { frames } };
  },
});
