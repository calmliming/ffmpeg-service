import { z } from 'zod';
import { numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  atOrAfter,
  formatSeconds,
  grabFrame,
  imageFormatParam,
  lastFrameTime,
  probeVideo,
  qualityParam,
  round3,
  seconds,
  seekArgs,
  seekPlans,
  widthFilters,
  widthParam,
} from './shared';

/** 候选帧数量：thumbnail 滤镜在候选里挑颜色分布最接近平均的一帧 */
const CANDIDATES = 200;
/** 分析窗口超过这个秒数时只解码关键帧，长视频挑封面不必整段解码 */
const KEYFRAME_ONLY_SECONDS = 300;
const ANALYZE_SHARE = 0.85;

const params = z.object({
  startTime: timeParam('startTime')
    .optional()
    .meta({ description: '从第几秒开始挑选（秒或 HH:MM:SS），可跳过片头，默认 0' }),
  within: numberParam('within', { min: 1, max: 86400 })
    .optional()
    .meta({ description: '只在 startTime 之后的多少秒内挑选（1-86400），默认到视频结尾' }),
  width: widthParam('封面宽度（像素），高度按比例；不传则为原始分辨率'),
  format: imageFormatParam('jpg'),
  quality: qualityParam(90),
});

/** 从 thumbnail 滤镜的日志里取选中帧的时间：frame id #6 (pts_time=1.200000) selected from a set of 10 images */
export function parseSelectedTime(stderr: string): number | undefined {
  const match = /pts_time=(\d+(?:\.\d+)?)\)\s*selected from a set/.exec(stderr);
  return match ? Number(match[1]) : undefined;
}

export const cover = defineOperation({
  name: 'video.cover',
  route: '/api/video/cover',
  title: '智能封面',
  description:
    '用 FFmpeg 的 thumbnail 滤镜在视频（或开头一段）里挑出最有代表性的一帧作为封面，避开黑场和转场。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '视频文件' }],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/cover \\',
    '  -F "file=@video.mp4" \\',
    '  -F "startTime=3" \\',
    '  -F "within=60" \\',
    '  -F "width=1280"',
    '',
    '# 用 URL 提交',
    'curl -X POST http://localhost:9527/api/video/cover \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","format":"webp"}\'',
  ].join('\n'),
  notes: [
    `在分析范围内均匀取约 ${CANDIDATES} 个候选帧，选颜色分布最接近整体平均的一帧，再按原始分辨率截取`,
    `分析范围超过 ${KEYFRAME_ONLY_SECONDS} 秒时只解码关键帧，长视频也很快`,
    'result.data.time 是选中画面的时间（秒）',
    '画面太短（不足两帧）时直接取 startTime 处的画面',
    'width 为 16-7680；按比例算出的高度也不能超过 7680，总像素不超过 7680x4320',
  ],
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
    // 尺寸超限要在分析之前就拦下，不白跑一遍解码
    const filters = widthFilters(info, p.width);
    const window = Math.min(duration - start, p.within ?? Infinity);
    let time = start;

    if (window * info.fps >= 2) {
      // 没有索引的容器（MPEG-TS 等）直接跳到 start 会从之后的关键帧才开始解码，窗口开头一段就丢了：
      // 先跳到 start 之前，再在 select 里从 start 开始取候选（见 seekPlans）
      const plan = seekPlans(info, start)[0];
      // select 按时间间隔取候选，保留时间戳，thumbnail 选中的帧时间加上跳转点就是真实位置
      const gap = (window / CANDIDATES).toFixed(6);
      const from = plan.offset > 0 ? `${atOrAfter(plan.offset)}*` : '';
      const analyze = [
        `select='${from}(isnan(prev_selected_t)+gte(t-prev_selected_t,${gap}))'`,
        'scale=160:-2',
        'thumbnail=n=1000',
      ];
      const args = window > KEYFRAME_ONLY_SECONDS ? ['-skip_frame', 'nokey'] : [];
      args.push(
        ...seekArgs(plan),
        '-t',
        seconds(plan.offset + window),
        '-i',
        file,
        '-map',
        '0:V:0',
        '-vf',
        analyze.join(','),
        '-f',
        'null',
        '-',
      );
      const { stderr } = await ctx.ffmpeg(args, {
        duration: plan.offset + window,
        range: [0, ANALYZE_SHARE],
        logLevel: 'info',
        captureStderr: true,
      });
      const selected = parseSelectedTime(stderr);
      if (selected === undefined) ctx.log('thumbnail 滤镜没有给出选中帧，退回到开始时间');
      else time = plan.seek + selected;
    }

    const out = ctx.outputPath(p.format);
    const grabbed = await grabFrame(ctx, file, info, {
      time: Math.min(time, lastFrameTime(info)),
      filters,
      format: p.format,
      quality: p.quality,
      out,
      range: [ANALYZE_SHARE, 1],
    });
    return { files: [out], data: { time: round3(grabbed) } };
  },
});
