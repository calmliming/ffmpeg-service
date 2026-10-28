import { z } from 'zod';
import { colorParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AAC_ENCODE,
  audioPassthroughArgs,
  evenFloor,
  evenRound,
  fitsMaxSize,
  MAX_LONG_SIDE,
  maxSizeError,
  MP4_OUTPUT,
  num,
  probeVideo,
  requireDuration,
  VIDEO_ENCODE,
  type VideoSource,
} from './common';

const LAYOUTS = ['horizontal', 'vertical', 'grid'] as const;
type Layout = (typeof LAYOUTS)[number];
export const MAX_STACK_INPUTS = 9;

const params = z.object({
  layout: enumParam('layout', LAYOUTS).default('horizontal').meta({
    description:
      '排列方式：horizontal（左右并排，默认）、vertical（上下排列）、grid（宫格，默认列数为 √n 向上取整，如 4 个为 2x2、9 个为 3x3）',
  }),
  columns: numberParam('columns', { min: 1, max: MAX_STACK_INPUTS, int: true })
    .optional()
    .meta({ description: 'grid 布局的列数（1-9），默认自动' }),
  height: numberParam('height', { min: 2, max: MAX_LONG_SIDE, int: true }).optional().meta({
    description:
      'horizontal：所有画面统一缩放到的高度，默认取最矮的输入；grid：每格的高度。vertical 布局不能使用',
  }),
  width: numberParam('width', { min: 2, max: MAX_LONG_SIDE, int: true }).optional().meta({
    description:
      'vertical：所有画面统一缩放到的宽度，默认取最窄的输入；grid：每格的宽度。horizontal 布局不能使用',
  }),
  gap: numberParam('gap', { min: 0, max: 200, int: true })
    .default(0)
    .meta({ description: '画面之间的间隔（像素，0-200），默认 0；奇数会向上取偶数' }),
  gapColor: colorParam('gapColor')
    .default('black')
    .meta({ description: '间隔、宫格空位和格内留白的颜色，默认 black' }),
  audio: enumParam('audio', ['first', 'mix', 'none']).default('first').meta({
    description: '音频：first（第 1 个视频的声音，默认）、mix（所有视频的声音混合）、none（无声）',
  }),
  duration: enumParam('duration', ['shortest', 'longest']).default('shortest').meta({
    description:
      '输出时长：shortest（最短的视频结束时结束，默认）、longest（最长的视频结束时结束，先结束的画面停在最后一帧）',
  }),
});

type StackParams = z.output<typeof params>;

export interface StackCell {
  /** 该输入缩放后的画面尺寸 */
  width: number;
  height: number;
  /** 在输出画面中的位置 */
  x: number;
  y: number;
  /** grid 布局：格子尺寸（画面等比缩放后居中补边） */
  cellWidth?: number;
  cellHeight?: number;
}

export interface StackPlan {
  width: number;
  height: number;
  columns: number;
  rows: number;
  cells: StackCell[];
  /** 是否有空隙需要填色（间隔或空格） */
  needsFill: boolean;
}

/** 按布局计算每个输入的尺寸和位置；sizes 是滤镜看到的输入画面尺寸（偶数） */
export function planStack(
  sizes: { width: number; height: number }[],
  p: Pick<StackParams, 'layout' | 'columns' | 'width' | 'height' | 'gap'>,
): StackPlan {
  const n = sizes.length;
  // 奇数间隔会让总宽高变成奇数，libx264 的 yuv420p 直接拒绝；向上取偶数，1 像素的分隔线不至于消失
  const gap = Math.ceil(p.gap / 2) * 2;
  const layout: Layout = p.layout;
  let plan: StackPlan;
  if (layout === 'horizontal') {
    const h = evenFloor(p.height ?? Math.min(...sizes.map((s) => s.height)));
    let x = 0;
    const cells = sizes.map((s) => {
      const cell = { width: evenRound((s.width * h) / s.height), height: h, x, y: 0 };
      x += cell.width + gap;
      return cell;
    });
    plan = { width: x - gap, height: h, columns: n, rows: 1, cells, needsFill: gap > 0 };
  } else if (layout === 'vertical') {
    const w = evenFloor(p.width ?? Math.min(...sizes.map((s) => s.width)));
    let y = 0;
    const cells = sizes.map((s) => {
      const cell = { width: w, height: evenRound((s.height * w) / s.width), x: 0, y };
      y += cell.height + gap;
      return cell;
    });
    plan = { width: w, height: y - gap, columns: 1, rows: n, cells, needsFill: gap > 0 };
  } else {
    const columns = Math.min(p.columns ?? Math.ceil(Math.sqrt(n)), n);
    const rows = Math.ceil(n / columns);
    // 默认格子取面积最小的输入的尺寸，保持一个真实存在的比例
    const ref = sizes.reduce((a, b) => (b.width * b.height < a.width * a.height ? b : a));
    let cellW: number;
    let cellH: number;
    if (p.width !== undefined && p.height !== undefined) {
      cellW = evenFloor(p.width);
      cellH = evenFloor(p.height);
    } else if (p.width !== undefined) {
      cellW = evenFloor(p.width);
      cellH = evenRound((ref.height * cellW) / ref.width);
    } else if (p.height !== undefined) {
      cellH = evenFloor(p.height);
      cellW = evenRound((ref.width * cellH) / ref.height);
    } else {
      cellW = evenFloor(ref.width);
      cellH = evenFloor(ref.height);
    }
    const cells = sizes.map((s, i) => {
      const factor = Math.min(cellW / s.width, cellH / s.height);
      return {
        width: Math.min(cellW, evenRound(s.width * factor)),
        height: Math.min(cellH, evenRound(s.height * factor)),
        x: (i % columns) * (cellW + gap),
        y: Math.floor(i / columns) * (cellH + gap),
        cellWidth: cellW,
        cellHeight: cellH,
      };
    });
    plan = {
      width: columns * cellW + (columns - 1) * gap,
      height: rows * cellH + (rows - 1) * gap,
      columns,
      rows,
      cells,
      needsFill: gap > 0 || rows * columns > n,
    };
  }
  return plan;
}

export const stack = defineOperation({
  name: 'video.stack',
  route: '/api/video/stack',
  title: '多画面拼接',
  description:
    '把 2-9 个视频左右并排、上下排列或排成宫格同屏播放，常用于对比、反应视频和多机位展示。',
  inputs: [
    {
      name: 'files',
      kind: 'video',
      required: true,
      multiple: { min: 2, max: MAX_STACK_INPUTS },
      // 和 merge 一致：filesUrls 是约定的默认字段名，urls 更顺手
      urlFields: ['filesUrls', 'urls'],
      description:
        '要拼接的视频，2-9 个，按提交顺序从左到右、从上到下排列。URL 方式用 filesUrls 或 urls 数组',
    },
  ],
  params,
  chainable: false,
  example: [
    '# 两个视频左右并排，中间 10 像素白色间隔',
    'curl -X POST http://localhost:9527/api/video/stack \\',
    '  -F "files=@left.mp4" -F "files=@right.mp4" -F "gap=10" -F "gapColor=white"',
    '',
    '# 4 个视频 2x2 宫格，声音混合，按最长的视频输出（URL 输入）',
    'curl -X POST http://localhost:9527/api/video/stack \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"filesUrls":["https://example.com/1.mp4","https://example.com/2.mp4","https://example.com/3.mp4","https://example.com/4.mp4"],"layout":"grid","audio":"mix","duration":"longest"}\'',
  ].join('\n'),
  notes: [
    'horizontal 把所有画面等比缩放到同一高度（默认最矮输入的高度），vertical 统一宽度（默认最窄输入的宽度）；grid 每格默认是面积最小的输入的尺寸，画面等比缩放后在格内居中，空位和留白用 gapColor 填充。',
    `拼接后的画面最大 ${MAX_LONG_SIDE}x4320（竖屏 4320x${MAX_LONG_SIDE}），超出时任务失败，请调小 height / width 或改用 grid。`,
    '帧率统一为第 1 个视频的帧率。duration=longest 时先结束的画面停在最后一帧。',
    'gap 为奇数时向上取偶数（如 5 → 6），保证输出宽高是偶数（H.264 yuv420p 的要求）。',
    'URL 方式提交时视频链接放在 filesUrls（或 urls）数组里。',
    'audio=first 时第 1 个视频没有音轨则输出无声；audio=mix 把所有带音轨的视频混合（不压低音量，带限幅防爆音）。',
    '画面重新编码为 H.264；audio=first 时 AAC / MP3 音轨直接复制，其他情况转为 AAC。',
  ],
  check(p, provided) {
    const count = provided.files ?? 0;
    if (count < 2 || count > MAX_STACK_INPUTS) {
      return `files 需要 2-${MAX_STACK_INPUTS} 个视频，当前 ${count} 个`;
    }
    if (p.layout === 'horizontal' && p.width !== undefined) {
      return 'horizontal 布局用 height 统一高度，不能指定 width';
    }
    if (p.layout === 'vertical' && p.height !== undefined) {
      return 'vertical 布局用 width 统一宽度，不能指定 height';
    }
    if (p.columns !== undefined && p.layout !== 'grid')
      return 'columns 只能和 layout=grid 一起使用';
    return undefined;
  },
  async run(ctx, p) {
    const files = ctx.inputs.files ?? [];
    if (files.length < 2) throw new Error('files 至少需要 2 个视频');
    const sources: VideoSource[] = [];
    for (let i = 0; i < files.length; i++) {
      const label = `第 ${i + 1} 个视频`;
      const source = await probeVideo(ctx, files[i], label);
      requireDuration(source, label);
      sources.push(source);
    }
    const durations = sources.map((s) => s.media.duration);
    const duration = p.duration === 'longest' ? Math.max(...durations) : Math.min(...durations);
    const plan = planStack(sources, p);
    if (!fitsMaxSize(plan.width, plan.height)) {
      throw new Error(
        `${maxSizeError('拼接后的画面', plan.width, plan.height)}，请调小 height / width 或改用 grid 布局`,
      );
    }
    const fps = sources[0].fpsExpr;
    ctx.log(
      `拼接 ${sources.length} 个视频：${p.layout} ${plan.columns}x${plan.rows} → ${plan.width}x${plan.height}，${num(duration)} 秒`,
    );

    const graph: string[] = sources.map((s, i) => {
      const cell = plan.cells[i];
      const chain = [...s.prefilters];
      if (cell.cellWidth !== undefined && cell.cellHeight !== undefined) {
        chain.push(
          `scale=${cell.width}:${cell.height}`,
          `pad=${cell.cellWidth}:${cell.cellHeight}:(ow-iw)/2:(oh-ih)/2:color=${p.gapColor}`,
        );
      } else {
        chain.push(`scale=${cell.width}:${cell.height}`);
      }
      // xstack 要求像素格式一致；帧率不统一时 xstack 每来一帧就出一帧，输出会变成可变帧率
      chain.push('setsar=1', `fps=${fps}`, 'format=yuv420p');
      return `[${i}:V:0]${chain.join(',')}[v${i}]`;
    });
    const labels = sources.map((_, i) => `[v${i}]`).join('');
    const layout = plan.cells.map((c) => `${c.x}_${c.y}`).join('|');
    const xstack = [`inputs=${sources.length}`, `layout=${layout}`];
    if (plan.needsFill) xstack.push(`fill=${p.gapColor}`);
    // shortest=0 时先结束的输入停在最后一帧，正好是 longest 的效果
    xstack.push(`shortest=${p.duration === 'shortest' ? 1 : 0}`);
    graph.push(`${labels}xstack=${xstack.join(':')}[v]`);

    let audioArgs: string[] = ['-an'];
    if (p.audio === 'first') {
      if (sources[0].media.audio) {
        audioArgs = ['-map', '0:a:0', ...audioPassthroughArgs(sources[0].media)];
      } else {
        ctx.log('第 1 个视频没有音轨，输出无声音');
      }
    } else if (p.audio === 'mix') {
      const withAudio = sources.map((s, i) => (s.media.audio ? i : -1)).filter((i) => i >= 0);
      if (withAudio.length === 0) {
        ctx.log('所有视频都没有音轨，输出无声音');
      } else if (withAudio.length === 1) {
        const i = withAudio[0];
        audioArgs = ['-map', `${i}:a:0`, ...audioPassthroughArgs(sources[i].media)];
      } else {
        // 统一采样率和声道，amix 才能稳定协商格式；不做 normalize，用 alimiter 防削波（和 compose 一致）
        for (const i of withAudio) {
          graph.push(`[${i}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
        }
        const inputs = withAudio.map((i) => `[a${i}]`).join('');
        graph.push(
          `${inputs}amix=inputs=${withAudio.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=0:latency=1[aout]`,
        );
        audioArgs = ['-map', '[aout]', ...AAC_ENCODE];
      }
    }

    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(
      [
        ...files.flatMap((file) => ['-i', file]),
        '-filter_complex',
        graph.join(';'),
        '-map',
        '[v]',
        ...audioArgs,
        ...VIDEO_ENCODE,
        '-t',
        num(duration),
        ...MP4_OUTPUT,
        '-y',
        output,
      ],
      { duration },
    );
    return {
      files: [output],
      data: {
        width: plan.width,
        height: plan.height,
        layout: p.layout,
        columns: plan.columns,
        rows: plan.rows,
        duration,
      },
    };
  },
});
