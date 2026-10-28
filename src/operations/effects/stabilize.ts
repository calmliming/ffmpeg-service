import { z } from 'zod';
import { booleanParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { VIDEO_INPUT, assertFrameSize, filterChainArgs, inspectVideo, num } from './shared';

/** 第一遍分析写出的运动数据文件，放在 workDir 里只写文件名：滤镜参数里的 Windows 盘符冒号会被当成分隔符 */
const TRANSFORMS_FILE = 'transforms.trf';
/** 分析遍占总进度的比例 */
const ANALYZE_SHARE = 0.5;

const params = z.object({
  smoothing: numberParam('smoothing', { min: 1, max: 100, int: true }).default(10).meta({
    description: '平滑程度 1-100，默认 10：用前后各多少帧来平滑镜头运动，越大越稳但跟随越慢',
  }),
  shakiness: numberParam('shakiness', { min: 1, max: 10, int: true })
    .default(5)
    .meta({ description: '原片抖动程度 1-10，默认 5；抖得厉害的素材调高' }),
  zoom: numberParam('zoom', { min: 0, max: 20 })
    .default(0)
    .meta({ description: '额外放大的百分比 0-20，默认 0；用来进一步裁掉边缘的黑边' }),
  autoZoom: booleanParam('autoZoom')
    .default(true)
    .meta({ description: '自动计算刚好能藏住黑边的固定放大比例（默认 true）' }),
  crop: enumParam('crop', ['black', 'keep'] as const)
    .default('black')
    .meta({
      description: '画面移出后边缘的填充方式：black 黑色（默认）或 keep 沿用上一帧的内容',
    }),
  tripod: booleanParam('tripod').default(false).meta({
    description: '三脚架模式：把镜头完全固定在第一帧的位置（忽略 smoothing），适合本应静止的机位',
  }),
  sharpen: booleanParam('sharpen')
    .default(true)
    .meta({ description: '稳定后轻微锐化，抵消变换插值带来的模糊（默认 true）' }),
});

export const stabilize = defineOperation({
  name: 'video.stabilize',
  route: '/api/video/stabilize',
  title: '视频防抖',
  description: '分析镜头抖动并平滑补偿（vid.stab 两遍处理），让手持拍摄的画面更稳定。',
  inputs: VIDEO_INPUT,
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/stabilize \\',
    '  -F "file=@shaky.mp4" \\',
    '  -F "smoothing=20" -F "shakiness=8"',
  ].join('\n'),
  notes: [
    '两遍处理：第一遍分析运动（任务 phase 为 analyzing，进度 0-50%），第二遍变换并编码（phase 为 processing，50-100%），耗时约为普通转码的两倍。',
    'autoZoom 开启时会自动放大到看不见黑边；zoom 在此基础上再额外放大。关闭 autoZoom 时边缘按 crop 的方式填充。',
    'tripod=true 时镜头锁定在第一帧的位置，smoothing 不再生效；机位本身在移动（走路、平移）的素材不要用。',
    '画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。',
  ],
  async run(ctx, p) {
    const input = await inspectVideo(ctx, ctx.inputs.file[0]);
    assertFrameSize(input);
    const tripod = p.tripod ? ':tripod=1' : '';

    ctx.progress(0, { phase: 'analyzing' });
    await ctx.ffmpeg(
      [
        '-i',
        input.file,
        '-map',
        `0:${input.videoIndex}`,
        '-vf',
        `vidstabdetect=shakiness=${p.shakiness}:accuracy=15:result=${TRANSFORMS_FILE}${tripod}`,
        '-an',
        '-f',
        'null',
        '-',
      ],
      { duration: input.duration, range: [0, ANALYZE_SHARE] },
    );

    ctx.progress(ANALYZE_SHARE, { phase: 'processing' });
    const transform = [
      `vidstabtransform=input=${TRANSFORMS_FILE}`,
      `smoothing=${p.smoothing}`,
      `zoom=${num(p.zoom)}`,
      `optzoom=${p.autoZoom ? 1 : 0}`,
      `crop=${p.crop}`,
    ].join(':');
    const filters = [`${transform}${tripod}`];
    // vid.stab 官方推荐的变换后锐化参数
    if (p.sharpen) filters.push('unsharp=5:5:0.8:3:3:0.4');

    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(filterChainArgs(input, filters, output), {
      duration: input.duration,
      range: [ANALYZE_SHARE, 1],
    });
    return { files: [output] };
  },
});
