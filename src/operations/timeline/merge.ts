import fs from 'fs';
import { z } from 'zod';
import {
  concatListContent,
  findIncompatibilities,
  pickNormalizeTarget,
  type NormalizeTarget,
} from '../../services/compose.service';
import { colorParam, enumParam, numberParam, sizeParam, toList } from '../../schemas/coerce';
import type { MediaSummary } from '../../utils/media-probe';
import { defineOperation } from '../types';
import {
  AUDIO_ENCODE,
  FASTSTART,
  MAX_HEIGHT,
  MAX_WIDTH,
  VIDEO_ENCODE,
  copyContainer,
  fmtSec,
  mainDuration,
  num,
  parseRate,
  probeInput,
  sec,
} from './shared';

export const MAX_MERGE_FILES = 20;
/** 所有片段加起来的时长上限 */
export const MAX_MERGE_SECONDS = 4 * 3600;
/** 需要统一转码时转码占的进度比例，剩下的给最终拼接 */
const NORMALIZE_SHARE = 0.85;
/** 有转场时最终合成要重新编码一遍，占的比例更大 */
const TRANSITION_NORMALIZE_SHARE = 0.55;

// FFmpeg 8.x 的 xfade 全部内置转场（不含 custom）
export const XFADE_TRANSITIONS = [
  'fade',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circlecrop',
  'rectcrop',
  'distance',
  'fadeblack',
  'fadewhite',
  'radial',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'circleopen',
  'circleclose',
  'vertopen',
  'vertclose',
  'horzopen',
  'horzclose',
  'dissolve',
  'pixelize',
  'diagtl',
  'diagtr',
  'diagbl',
  'diagbr',
  'hlslice',
  'hrslice',
  'vuslice',
  'vdslice',
  'hblur',
  'fadegrays',
  'wipetl',
  'wipetr',
  'wipebl',
  'wipebr',
  'squeezeh',
  'squeezev',
  'zoomin',
  'fadefast',
  'fadeslow',
  'hlwind',
  'hrwind',
  'vuwind',
  'vdwind',
  'coverleft',
  'coverright',
  'coverup',
  'coverdown',
  'revealleft',
  'revealright',
  'revealup',
  'revealdown',
] as const;
const TRANSITION_SET = new Set<string>(XFADE_TRANSITIONS);

const MP4_COPY_VIDEO = new Set(['h264', 'hevc', 'av1', 'mpeg4']);
const MP4_COPY_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

const transitionParam = z.preprocess(
  (value, ctx) => {
    const list = toList(value);
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      ctx.issues.push({
        code: 'custom',
        message: 'transition 必须是转场名称或名称列表',
        input: value,
      });
      return z.NEVER;
    }
    const names = (list as string[]).map((item) => item.trim().toLowerCase());
    if (names.length === 1 && names[0] === 'none') return [];
    const bad = names.find((name) => !TRANSITION_SET.has(name));
    if (bad !== undefined || names.length === 0) {
      const message =
        bad === 'none'
          ? 'transition 为 none 时不能再指定其他转场'
          : `transition 只能是 none 或 FFmpeg xfade 转场名（如 fade、dissolve、wipeleft、slideup、circleopen），"${bad?.slice(0, 20) ?? ''}" 不支持`;
      ctx.issues.push({ code: 'custom', message, input: value });
      return z.NEVER;
    }
    if (names.length > MAX_MERGE_FILES - 1) {
      ctx.issues.push({
        code: 'custom',
        message: `transition 最多 ${MAX_MERGE_FILES - 1} 个`,
        input: value,
      });
      return z.NEVER;
    }
    return names;
  },
  z.array(z.enum(XFADE_TRANSITIONS)),
);

interface NormalizeOptions {
  target: NormalizeTarget;
  fit: 'pad' | 'crop';
  background: string;
  withAudio: boolean;
  /** 有转场时是中间文件：画质更高、音频用 PCM，最终合成时只编码一次 */
  intermediate: boolean;
}

/** 把一个片段转成统一的分辨率、帧率、像素格式和采样率；没有音轨的片段补静音 */
export function buildClipArgs(
  input: string,
  media: MediaSummary,
  o: NormalizeOptions,
  output: string,
): string[] {
  const { width: w, height: h, fps, sampleRate } = o.target;
  const args = ['-i', input];
  const ownAudio = o.withAudio && Boolean(media.audio);
  if (o.withAudio && !ownAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=stereo`);
  }
  // reset_sar：按显示比例（考虑 SAR）缩放成方形像素。否则非方形像素的素材按存储宽高算比例，
  // 再被 setsar=1 拉回方形像素后画面变形、多出黑边
  const fit =
    o.fit === 'crop'
      ? [`scale=${w}:${h}:force_original_aspect_ratio=increase:reset_sar=1`, `crop=${w}:${h}`]
      : [
          `scale=${w}:${h}:force_original_aspect_ratio=decrease:reset_sar=1`,
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${o.background}`,
        ];
  args.push('-map', '0:V:0', '-vf', [...fit, 'setsar=1', `fps=${fps}`, 'format=yuv420p'].join(','));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', o.intermediate ? '17' : '23');
  if (o.withAudio) {
    // 音轨比画面短时补静音到画面长度，再按画面时长截断，片段之间不会累积音画错位
    args.push('-map', ownAudio ? '0:a:0' : '1:a:0', '-af', 'apad');
    args.push(...(o.intermediate ? ['-c:a', 'pcm_s16le'] : AUDIO_ENCODE));
    args.push('-ar', String(sampleRate), '-ac', '2');
  } else {
    args.push('-an');
  }
  args.push('-t', sec(mainDuration(media)), '-y', output);
  return args;
}

/** xfade 的 offset 是相对已合成部分的起点：前 k+1 段总长减去 k+1 次重叠 */
export function transitionOffsets(durations: number[], overlap: number): number[] {
  const offsets: number[] = [];
  let sum = 0;
  for (let k = 0; k < durations.length - 1; k++) {
    sum += durations[k];
    offsets.push(sum - (k + 1) * overlap);
  }
  return offsets;
}

/** 时间对齐到最近的一帧 */
export function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

/**
 * 写给 xfade 的 offset。xfade 从第一个 pts ≥ offset 的帧开始转场，offset 正好落在帧上时，
 * 毫秒级取整或 ffprobe 时长的小数误差会让转场晚一帧；往前让半帧，转场稳定从 start 这一帧开始
 */
export function xfadeOffsetArg(start: number, fps: number): string {
  return num(Math.max(0, start - 0.5 / fps));
}

export const mergeOperation = defineOperation({
  name: 'merge',
  route: '/api/edit/merge',
  title: '视频拼接',
  description:
    '把 2-20 个视频按顺序首尾拼接成一个 MP4，可在片段之间加转场（淡化、擦除、滑动、圆形展开等 50 多种）。分辨率、帧率不同的视频会自动统一。',
  inputs: [
    {
      name: 'files',
      kind: 'video',
      required: true,
      multiple: { min: 2, max: MAX_MERGE_FILES },
      urlFields: ['filesUrls', 'videos', 'urls'],
      description: '要拼接的视频，按上传或 URL 的顺序拼接，2-20 个',
    },
  ],
  params: z.object({
    transition: transitionParam.default([]).meta({
      description:
        '转场效果：none（默认，直接拼接）或 xfade 转场名，如 fade、dissolve、fadeblack、fadewhite、wipeleft、slideleft、circleopen、radial、pixelize、zoomin。多个用逗号分隔时按顺序用于每个衔接处（不够则循环）',
    }),
    transitionDuration: numberParam('transitionDuration', { min: 0.1, max: 5 }).default(1).meta({
      description: '转场时长（秒），0.1-5，默认 1；必须小于每个视频的时长',
    }),
    size: sizeParam('size').optional().meta({
      description:
        '输出分辨率，如 1280x720，最大 7680x4320（竖屏 4320x7680）。默认使用第 1 个视频的分辨率；指定后所有视频都会转码',
    }),
    fps: numberParam('fps', { min: 1, max: 120 }).optional().meta({
      description: '输出帧率，1-120。默认使用第 1 个视频的帧率；指定后所有视频都会转码',
    }),
    fit: enumParam('fit', ['pad', 'crop']).default('pad').meta({
      description:
        '画面比例不同时的处理：pad（默认，等比缩放后补边）、crop（等比放大后裁掉多余部分，铺满画面）',
    }),
    background: colorParam('background').default('black').meta({
      description: 'fit=pad 时补边的颜色，默认 black',
    }),
  }),
  check(params, provided) {
    const count = provided.files ?? 0;
    if (count < 2) return '请至少提供 2 个视频';
    if (count > MAX_MERGE_FILES) return `最多拼接 ${MAX_MERGE_FILES} 个视频，当前 ${count} 个`;
    // 横竖屏都允许：宽高任一方向放得进 8K 即可
    const size = params.size;
    if (
      size &&
      (size.width > MAX_WIDTH || size.height > MAX_HEIGHT) &&
      (size.width > MAX_HEIGHT || size.height > MAX_WIDTH)
    ) {
      return `size 不能超过 ${MAX_WIDTH}x${MAX_HEIGHT}（竖屏 ${MAX_HEIGHT}x${MAX_WIDTH}）`;
    }
    return undefined;
  },
  example: [
    'curl -X POST http://localhost:9527/api/edit/merge \\',
    '  -F "files=@video1.mp4" \\',
    '  -F "files=@video2.mp4" \\',
    '  -F "files=@video3.mp4" \\',
    '  -F "transition=fade" \\',
    '  -F "transitionDuration=0.8"',
    '',
    '# URL 输入，不同衔接处用不同转场',
    'curl -X POST http://localhost:9527/api/edit/merge \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"filesUrls":["https://example.com/a.mp4","https://example.com/b.mp4","https://example.com/c.mp4"],"transition":"wipeleft,circleopen"}\'',
  ].join('\n'),
  notes: [
    `2-${MAX_MERGE_FILES} 个视频，总时长不超过 ${MAX_MERGE_SECONDS / 3600} 小时；输出始终是 MP4（H.264 + AAC，或原编码流复制）。`,
    '不加转场时：所有视频编码、分辨率、帧率、音频参数完全一致就直接流复制（秒级完成、画质无损），否则逐个转码成第 1 个视频的参数后再拼接。',
    '加转场时：先把每个视频统一成相同的分辨率、帧率和采样率，再用 xfade（画面）+ acrossfade（声音）一次合成。每个转场让总时长减少 transitionDuration 秒。',
    '没有音轨的视频会补上静音，保证后面片段的声音不会提前；所有视频都没有声音时输出也没有音轨。',
    '分辨率或比例不同的视频按 fit 处理：pad 补边（颜色由 background 指定）、crop 裁切铺满。',
    '画面带旋转信息（手机竖拍）的视频按转正后的方向处理：目标分辨率取第 1 个视频转正后的宽高；旋转角度不同的视频不能直接流复制，会先转正再拼接。统一转码时，非方形像素（SAR 不是 1:1）的视频按显示比例缩放。',
  ],
  async run(ctx, params) {
    const files = ctx.inputs.files ?? [];
    if (files.length < 2) throw new Error('请至少提供 2 个视频');

    ctx.progress(0, { phase: 'analyzing' });
    const probes: MediaSummary[] = [];
    for (let i = 0; i < files.length; i++) {
      const media = await probeInput(ctx, files[i], `第 ${i + 1} 个视频`);
      if (!media.video) throw new Error(`第 ${i + 1} 个文件不包含视频画面`);
      probes.push(media);
    }
    const durations = probes.map(mainDuration);
    const total = durations.reduce((sum, d) => sum + d, 0);
    if (total > MAX_MERGE_SECONDS) {
      throw new Error(`视频总时长 ${fmtSec(total)} 秒超过上限 ${MAX_MERGE_SECONDS / 3600} 小时`);
    }

    const target = pickNormalizeTarget(probes);
    // 帧率字符串来自 ffprobe 的 r_frame_rate（形如 30000/1001），进滤镜前再确认一遍只有数字
    if (!/^\d{1,6}(\/\d{1,6})?$/.test(target.fps)) target.fps = '30';
    if (params.size) {
      target.width = Math.max(2, Math.round(params.size.width / 2) * 2);
      target.height = Math.max(2, Math.round(params.size.height / 2) * 2);
    }
    if (params.fps) target.fps = num(params.fps, 3);
    const withAudio = probes.some((media) => Boolean(media.audio));
    const clipOptions = {
      target,
      fit: params.fit,
      background: params.background,
      withAudio,
    };
    const output = ctx.outputPath('mp4');
    const n = files.length;

    if (params.transition.length === 0) {
      const reasons = findIncompatibilities(probes, true);
      const first = probes[0];
      if (reasons.length === 0) {
        const vcodec = first.video?.codec ?? '';
        const acodec = first.audio?.codec;
        if (!MP4_COPY_VIDEO.has(vcodec) || (acodec && !MP4_COPY_AUDIO.has(acodec))) {
          reasons.push(`编码 ${vcodec}${acodec ? ` / ${acodec}` : ''} 不能直接封装进 MP4`);
        }
      }
      if (params.size || params.fps) reasons.push('指定了 size 或 fps');
      const normalized = reasons.length > 0;

      let segments: string[] = [...files];
      if (normalized) {
        segments = [];
        let before = 0;
        for (let i = 0; i < n; i++) {
          ctx.progress((before / total) * NORMALIZE_SHARE, {
            phase: 'normalizing',
            currentVideoIndex: i + 1,
            totalVideos: n,
          });
          const clip = ctx.tempPath(`norm_${i}.mp4`);
          const args = buildClipArgs(
            files[i],
            probes[i],
            { ...clipOptions, intermediate: false },
            clip,
          );
          await ctx
            .ffmpeg(args, {
              duration: durations[i],
              range: [
                (before / total) * NORMALIZE_SHARE,
                ((before + durations[i]) / total) * NORMALIZE_SHARE,
              ],
            })
            .catch((err: Error) => {
              if (ctx.signal.aborted) throw err;
              throw new Error(`第 ${i + 1} 个视频转码失败: ${err.message}`);
            });
          before += durations[i];
          segments.push(clip);
        }
      }

      const list = ctx.tempPath('merge.ffconcat');
      await fs.promises.writeFile(list, concatListContent(segments));
      const args = ['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0'];
      if (withAudio) args.push('-map', '0:a:0');
      args.push('-c', 'copy');
      if (!normalized) args.push(...copyContainer(first).extraArgs);
      args.push(...FASTSTART, '-y', output);
      const start = normalized ? NORMALIZE_SHARE : 0;
      ctx.progress(start, { phase: 'merging', totalVideos: n });
      await ctx.ffmpeg(args, { duration: total, range: [start, 1] }).catch((err: Error) => {
        if (ctx.signal.aborted) throw err;
        throw new Error(`视频拼接失败: ${err.message}`);
      });
      return {
        files: [output],
        data: {
          duration: Number(total.toFixed(3)),
          normalized,
          reasons,
          transitions: [],
        },
      };
    }

    // 有转场：每个片段都要比转场长，否则 xfade 的 offset 会倒退
    const overlap = params.transitionDuration;
    durations.forEach((d, i) => {
      if (d <= overlap) {
        throw new Error(
          `第 ${i + 1} 个视频只有 ${fmtSec(d)} 秒，转场时长 ${fmtSec(overlap)} 秒必须小于每个视频的时长`,
        );
      }
    });

    const clips: string[] = [];
    let before = 0;
    for (let i = 0; i < n; i++) {
      const share = TRANSITION_NORMALIZE_SHARE;
      ctx.progress((before / total) * share, {
        phase: 'normalizing',
        currentVideoIndex: i + 1,
        totalVideos: n,
      });
      const clip = ctx.tempPath(`xf_${i}.mov`);
      const args = buildClipArgs(files[i], probes[i], { ...clipOptions, intermediate: true }, clip);
      await ctx
        .ffmpeg(args, {
          duration: durations[i],
          range: [(before / total) * share, ((before + durations[i]) / total) * share],
        })
        .catch((err: Error) => {
          if (ctx.signal.aborted) throw err;
          throw new Error(`第 ${i + 1} 个视频转码失败: ${err.message}`);
        });
      before += durations[i];
      clips.push(clip);
    }

    // 统一帧率后画面按整帧取整（20 fps 的 2.05 秒转成 30 fps 是 62 帧 2.0667 秒），声音仍是源时长。
    // offset 和每段声音的长度都以转码后的真实画面时长为准；ffprobe 只给 6 位小数，再对齐到整帧
    const fps = parseRate(target.fps) || 30;
    const actual: number[] = [];
    for (let i = 0; i < n; i++) {
      const info = await ctx.probe(clips[i]);
      const d = snapToFrame(info.video?.duration || info.duration, fps);
      if (d <= overlap) {
        throw new Error(
          `第 ${i + 1} 个视频只有 ${fmtSec(d)} 秒，转场时长 ${fmtSec(overlap)} 秒必须小于每个视频的时长`,
        );
      }
      actual.push(d);
    }
    const offsets = transitionOffsets(actual, overlap);
    const used = offsets.map((_, k) => params.transition[k % params.transition.length]);
    const duration = actual.reduce((sum, d) => sum + d, 0) - (n - 1) * overlap;

    const args: string[] = [];
    for (const clip of clips) args.push('-i', clip);
    const graph: string[] = [];
    // xfade 要求两路输入的时间基和帧率完全一致，这里再统一一次
    for (let i = 0; i < n; i++) {
      graph.push(`[${i}:v:0]fps=${target.fps},settb=AVTB,format=yuv420p[v${i}]`);
      if (withAudio) {
        // acrossfade 没有 offset，只是把每段声音首尾重叠着接起来，所以每段声音必须和该段画面一样长：
        // 短了后面的声音整体提前，一段差不到一帧，十几段就差出几百毫秒
        const samples = Math.round(actual[i] * target.sampleRate);
        graph.push(
          `[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=${target.sampleRate}:channel_layouts=stereo,` +
            `apad=whole_len=${samples},atrim=end_sample=${samples}[a${i}]`,
        );
      }
    }
    let video = 'v0';
    let audio = 'a0';
    for (let k = 1; k < n; k++) {
      // 画面只能在整帧处开始转场（取最近的一帧），声音按样本交叉，两者最多差半帧且不会逐段累积
      const offset = xfadeOffsetArg(snapToFrame(offsets[k - 1], fps), fps);
      const xf = `xfade=transition=${used[k - 1]}:duration=${num(overlap)}:offset=${offset}`;
      graph.push(`[${video}][v${k}]${xf}[xv${k}]`);
      video = `xv${k}`;
      if (withAudio) {
        graph.push(`[${audio}][a${k}]acrossfade=d=${num(overlap)}:c1=tri:c2=tri[xa${k}]`);
        audio = `xa${k}`;
      }
    }
    args.push('-filter_complex', graph.join(';'), '-map', `[${video}]`, ...VIDEO_ENCODE);
    if (withAudio) args.push('-map', `[${audio}]`, ...AUDIO_ENCODE);
    args.push(...FASTSTART, '-y', output);

    ctx.progress(TRANSITION_NORMALIZE_SHARE, { phase: 'merging', totalVideos: n });
    await ctx
      .ffmpeg(args, { duration, range: [TRANSITION_NORMALIZE_SHARE, 1] })
      .catch((err: Error) => {
        if (ctx.signal.aborted) throw err;
        throw new Error(`转场合成失败: ${err.message}`);
      });

    return {
      files: [output],
      data: {
        duration: Number(duration.toFixed(3)),
        normalized: true,
        reasons: [],
        transitions: used,
        transitionDuration: overlap,
        offsets: offsets.map((o) => Number(o.toFixed(3))),
      },
    };
  },
});
