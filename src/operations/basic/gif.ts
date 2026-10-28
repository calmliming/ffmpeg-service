import fs from 'fs';
import { z } from 'zod';
import { defineOperation } from '../types';
import { booleanParam, enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { parseFrameRate } from './encode';
import { inspectInput, keyframeSafeSeek } from './probe';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 动图很快就会变得很大：最长 60 秒、最宽 1280，GIF 帧率最高 50（帧间隔以 1/100 秒计，再高浏览器会按 10 fps 播） */
export const MAX_GIF_DURATION = 60;
export const MAX_GIF_WIDTH = 1280;
const MAX_GIF_HEIGHT = 2560;
const MAX_GIF_FPS = 50;

const FORMATS = ['gif', 'webp', 'apng'] as const;
const DITHERS = [
  'sierra2_4a',
  'floyd_steinberg',
  'bayer',
  'sierra2',
  'sierra3',
  'burkes',
  'atkinson',
  'none',
] as const;

const params = z.object({
  startTime: timeParam('startTime')
    .optional()
    .meta({ description: '起始时间：秒数或 HH:MM:SS（如 00:00:02），默认从头开始' }),
  duration: timeParam('duration')
    .optional()
    .meta({
      description: `截取时长（秒或 HH:MM:SS），最长 ${MAX_GIF_DURATION} 秒；不填时转到视频结尾，超过 ${MAX_GIF_DURATION} 秒只取前 ${MAX_GIF_DURATION} 秒`,
    }),
  width: numberParam('width', { min: 16, max: MAX_GIF_WIDTH, int: true })
    .default(320)
    .meta({ description: `动图宽度（像素），16-${MAX_GIF_WIDTH}，默认 320，高度按比例` }),
  fps: numberParam('fps', { min: 1, max: 60 })
    .default(10)
    .meta({ description: '帧率，默认 10。gif 最高 50，webp / apng 最高 60' }),
  format: enumParam('format', FORMATS).default('gif').meta({
    description:
      '输出格式：gif（默认）、webp（动态 WebP，体积小得多）、apng（动态 PNG，无损、体积大）',
  }),
  loop: numberParam('loop', { min: 0, max: 65535, int: true })
    .default(0)
    .meta({ description: '播放次数：0（默认）无限循环，1 只播一次，N 播 N 次' }),
  palette: booleanParam('palette').default(true).meta({
    description: '仅 gif：先为整段画面生成 256 色调色板再转换（画质好得多，多解码一遍），默认 true',
  }),
  dither: enumParam('dither', DITHERS)
    .optional()
    .meta({
      description: `仅 gif 且 palette=true：抖动算法，${DITHERS.join('、')}，默认 sierra2_4a。none 体积最小但有色带`,
    }),
  maxColors: numberParam('maxColors', { min: 2, max: 256, int: true }).optional().meta({
    description: '仅 gif 且 palette=true：调色板颜色数 2-256，默认 256；颜色越少文件越小',
  }),
  quality: numberParam('quality', { min: 0, max: 100, int: true })
    .optional()
    .meta({ description: '仅 webp：有损压缩质量 0-100，默认 75' }),
});

/** 统一用「总共播放几次」：GIF 的 NETSCAPE 循环次数是「额外重复几次」（-1 表示不写循环块），WebP / APNG 是总次数 */
export function gifLoopValue(plays: number): number {
  if (plays === 0) return 0;
  return plays === 1 ? -1 : plays - 1;
}

export const gif = defineOperation({
  name: 'gif',
  route: '/api/process/gif',
  title: '视频转动图',
  description:
    '把视频的一段转换成 GIF、动态 WebP 或 APNG 动图；GIF 默认使用全局调色板，色彩还原明显好于直接转换。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '视频文件' }],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/process/gif \\',
    '  -F "file=@video.mp4" -F "startTime=00:00:02" -F "duration=5" -F "width=480" -F "fps=15"',
    '',
    '# 用 URL 提交，输出只播一次的动态 WebP',
    'curl -X POST http://localhost:9527/api/process/gif -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","format":"webp","duration":3,"loop":1}\'',
  ].join('\n'),
  notes: [
    `上限：时长 ${MAX_GIF_DURATION} 秒、宽度 ${MAX_GIF_WIDTH}（旧版不限）。不填 duration 时转到视频结尾，视频更长时只取前 ${MAX_GIF_DURATION} 秒。`,
    'GIF 的帧间隔以 1/100 秒计，帧率最高 50，能整除 100 的帧率（10、20、25、50）播放最均匀。',
    'palette=true（默认）分两遍：第一遍为整段画面生成调色板，第二遍按调色板抖动输出，内存占用与时长无关。palette=false 与旧版行为一致（直接转换，色带明显）。',
    'apng 输出的扩展名是 .png（APNG 兼容 PNG，不支持动画的看图软件显示第一帧）。dither、maxColors 只对 gif 有效，quality 只对 webp 有效。',
    '高度按显示宽高比计算（考虑非方形像素和旋转元数据），最高 2560（1280 宽的 9:16 竖屏刚好 2276），超出时任务失败并提示减小 width。输出不含音频。',
    '起点按画面流的时长判断；起点落在最后一帧的显示区间里时从最后一帧开始，片段至少包含一帧（单帧的源输出单帧动图）。',
    'MPEG-TS / MPEG-PS（.ts、.mts、.m2ts、.mpg）输入先找起点之前的关键帧再解码，起始画面与请求的时间一致。',
  ],
  check(p) {
    if (p.duration !== undefined && p.duration <= 0) return 'duration 必须大于 0';
    if (p.duration !== undefined && p.duration > MAX_GIF_DURATION) {
      return `duration 不能超过 ${MAX_GIF_DURATION} 秒`;
    }
    if (p.format === 'gif' && p.fps > MAX_GIF_FPS) return `gif 的帧率最高 ${MAX_GIF_FPS}`;
    if ((p.dither || p.maxColors !== undefined) && (p.format !== 'gif' || !p.palette)) {
      return 'dither 和 maxColors 只在 format=gif 且 palette=true 时有效';
    }
    if (p.quality !== undefined && p.format !== 'webp') return 'quality 只在 format=webp 时有效';
    return undefined;
  },

  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await inspectInput(ctx, file);
    const video = info.media.video;
    if (!video) throw new Error('输入文件没有视频画面');
    // width 有上限，但高度按比例算：极端比例的源（100x8000 之类）会生成几万像素高的动图
    const { displayWidth: dw, displayHeight: dh } = info;
    const height = dw > 0 && dh > 0 ? Math.round((p.width * dh) / dw) : 0;
    if (height > MAX_GIF_HEIGHT) {
      throw new Error(
        `按画面比例计算的动图高度 ${height} 超过上限 ${MAX_GIF_HEIGHT}，请减小 width`,
      );
    }

    // 音轨可能比画面长，起点按画面流自己的时长判断
    const total = video.duration || info.media.duration;
    let start = round3(p.startTime ?? 0);
    if (total > 0 && start >= total) {
      throw new Error(`startTime（${start} 秒）超出了视频时长（${round3(total)} 秒）`);
    }
    // 跳转会丢掉时间戳早于起点的帧：起点落在最后一帧的显示区间里（10 秒视频从 9.98 秒开始）时一帧都不剩，
    // 后面生成调色板 / WebP 时只会报底层错误。退到最后一帧的时间点，输出单帧动图
    const sourceFps = parseFrameRate(video.avgFrameRate) || parseFrameRate(video.frameRate);
    if (total > 0 && sourceFps > 0) {
      const lastFrame = Math.max(0, Math.floor((total - 1 / sourceFps) * 1000) / 1000 - 0.001);
      if (start > lastFrame) {
        ctx.log(`startTime ${start}s 落在最后一帧之后，改从最后一帧（${lastFrame}s）开始`);
        start = lastFrame;
      }
    }
    let length = p.duration ?? MAX_GIF_DURATION;
    if (total > 0) length = Math.min(length, total - start);
    // 窗口至少盖住一帧源画面，否则起点恰好落在两帧之间时什么也取不到
    if (sourceFps > 0) length = Math.max(length, 1 / sourceFps);
    length = round3(length);

    // 输入端 -ss / -t：只解码需要的那一段，两遍调色板时也不会多读。
    // MPEG-TS / PS 的输入端跳转会落在关键帧之后，先跳到起点前的关键帧，再用 trim 在解码端截出 [start, start + length)。
    // 输入端 -t 从第一个解出的帧（关键帧）开始计时，只用来少读数据，终点以 trim 的 end 为准
    const from = (await keyframeSafeSeek(ctx, file, info, start)) ?? 0;
    const skip = round3(Math.max(0, start - from));
    const input = from > 0 ? ['-ss', String(from)] : [];
    input.push('-t', String(round3(skip + length)), '-i', file);
    const head =
      skip > 0 ? `trim=start=${skip}:end=${round3(skip + length)},setpts=PTS-STARTPTS,` : '';
    // fps 滤镜默认按四舍五入决定输出几帧，窗口不到半个输出帧（单帧的源、很短的 duration）时一帧都不输出；
    // eof_action=pass 让最后一帧照样输出。窗口更长时不加，否则结尾会多出一帧
    const eof = length * p.fps <= 0.5 ? ':eof_action=pass' : '';
    // 高度按显示宽高比（dar 含 SAR）计算；动图不要求偶数尺寸
    const base = `${head}fps=${p.fps}${eof},scale=${p.width}:'max(2,round(ow/dar))':flags=lanczos,setsar=1`;

    if (p.format === 'gif') {
      const out = ctx.outputPath('gif');
      const loop = String(gifLoopValue(p.loop));
      if (!p.palette) {
        await ctx.ffmpeg([...input, '-vf', base, '-an', '-loop', loop, '-f', 'gif', '-y', out], {
          duration: length,
        });
        return { files: [out] };
      }
      const palette = ctx.tempPath('palette.png');
      const colors = p.maxColors ?? 256;
      await ctx.ffmpeg(
        [
          ...input,
          '-vf',
          `${base},palettegen=max_colors=${colors}`,
          '-frames:v',
          '1',
          '-update',
          '1',
          '-y',
          palette,
        ],
        { duration: length, range: [0, 0.4] },
      );
      // 片段里一帧都没有时 palettegen 什么也不写、ffmpeg 照样以 0 退出，第二遍只会报「打不开 palette.png」
      const written = await fs.promises.stat(palette).then(
        (s) => s.size > 0,
        () => false,
      );
      if (!written) {
        throw new Error(
          `所选片段（${start} 秒起 ${length} 秒）里没有可用的画面，请调整 startTime 或 duration`,
        );
      }
      // diff_mode=rectangle 只重新抖动变化的区域，静止背景不闪且文件更小
      const use = `paletteuse=dither=${p.dither ?? 'sierra2_4a'}:diff_mode=rectangle`;
      await ctx.ffmpeg(
        [
          ...input,
          '-i',
          palette,
          '-filter_complex',
          `[0:v]${base}[x];[x][1:v]${use}[out]`,
          '-map',
          '[out]',
          '-loop',
          loop,
          '-f',
          'gif',
          '-y',
          out,
        ],
        { duration: length, range: [0.4, 1] },
      );
      return { files: [out] };
    }

    if (p.format === 'webp') {
      const out = ctx.outputPath('webp');
      await ctx.ffmpeg(
        [
          ...input,
          '-vf',
          base,
          '-an',
          '-c:v',
          'libwebp_anim',
          '-lossless',
          '0',
          '-quality',
          String(p.quality ?? 75),
          '-loop',
          String(p.loop),
          '-f',
          'webp',
          '-y',
          out,
        ],
        { duration: length },
      );
      return { files: [out] };
    }

    const out = ctx.outputPath('png');
    await ctx.ffmpeg(
      [
        ...input,
        '-vf',
        base,
        '-an',
        '-c:v',
        'apng',
        '-plays',
        String(p.loop),
        '-f',
        'apng',
        '-y',
        out,
      ],
      { duration: length },
    );
    return { files: [out] };
  },
});
