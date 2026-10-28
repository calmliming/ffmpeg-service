import fs from 'fs';
import { z } from 'zod';
import { enumParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AUDIO_ENCODE,
  FASTSTART,
  VIDEO_ENCODE,
  bareConcatList,
  copyAudioArgs,
  evenSizeFilters,
  fmtSec,
  mainDuration,
  probeInput,
  reencodeExt,
  sec,
  sourceFps,
} from './shared';

/** 倒放要把整段素材解码进内存，总时长封顶 10 分钟 */
export const MAX_REVERSE_SECONDS = 600;
/** 每段解码后的画面最多占用的内存，按每像素 3 字节估算（兼容 10 bit / 4:4:4 素材） */
const FRAME_BUDGET_BYTES = 768 * 1024 * 1024;
const MIN_SEGMENT = 1;
const MAX_VIDEO_SEGMENT = 5;
const AUDIO_SEGMENT = 30;
/** 末尾不足这个长度的零头并进前一段，避免产生只有一两帧的片段 */
const MIN_TAIL = 0.2;
const CONCAT_SHARE = 0.08;

/** reverse 滤镜会缓存整段画面，按分辨率决定每段多长，保证单段内存可控 */
export function reverseSegmentSeconds(width: number, height: number, fps: number): number {
  if (!width || !height) return AUDIO_SEGMENT;
  const frames = FRAME_BUDGET_BYTES / (width * height * 3);
  return Math.min(MAX_VIDEO_SEGMENT, Math.max(MIN_SEGMENT, frames / fps));
}

export function planSegments(total: number, length: number): { start: number; length: number }[] {
  const segments: { start: number; length: number }[] = [];
  for (let start = 0; start < total - 1e-6; start += length) {
    segments.push({ start, length: Math.min(length, total - start) });
  }
  const last = segments[segments.length - 1];
  if (segments.length > 1 && last.length < MIN_TAIL) {
    segments.pop();
    segments[segments.length - 1].length += last.length;
  }
  return segments;
}

export const reverseOperation = defineOperation({
  name: 'video.reverse',
  route: '/api/video/reverse',
  title: '视频倒放',
  description: '把视频（或音频）从尾到头倒着播放。长素材自动分段倒放再拼接，内存占用不随时长增长。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '视频或音频文件' }],
  params: z.object({
    audio: enumParam('audio', ['reverse', 'original', 'mute']).default('reverse').meta({
      description:
        '声音处理：reverse（默认，声音也倒放）、original（画面倒放、声音保持原样正向播放）、mute（去掉声音）',
    }),
  }),
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/reverse \\',
    '  -F "file=@video.mp4" \\',
    '  -F "audio=original"',
  ].join('\n'),
  notes: [
    `总时长上限 ${MAX_REVERSE_SECONDS / 60} 分钟。`,
    'FFmpeg 的 reverse / areverse 滤镜要把整段素材缓存在内存里，服务按分辨率把素材切成 1-5 秒的小段（4K 约 1 秒、1080p 约 5 秒），逐段倒放后倒序拼接。',
    '纯音频文件也可以倒放，输出 m4a（AAC）；audio=original 时画面倒放、原声正向播放。',
  ],
  async run(ctx, params) {
    const input = ctx.inputs.file[0];
    const media = await probeInput(ctx, input);
    const total = mainDuration(media);
    if (total > MAX_REVERSE_SECONDS) {
      throw new Error(
        `时长 ${fmtSec(total)} 秒超过倒放上限 ${MAX_REVERSE_SECONDS / 60} 分钟，请先裁剪`,
      );
    }
    const v = media.video;
    if (!v && params.audio !== 'reverse') {
      throw new Error(`纯音频文件只能 audio=reverse，audio=${params.audio} 时没有可倒放的内容`);
    }

    const segLen = reverseSegmentSeconds(v?.width ?? 0, v?.height ?? 0, sourceFps(media));
    const segments = planSegments(total, segLen);
    const reverseAudio = Boolean(media.audio) && params.audio === 'reverse';
    const names: string[] = [];
    let done = 0;

    ctx.progress(0, { phase: 'processing' });
    // 从最后一段开始处理，生成顺序就是拼接顺序
    for (let k = segments.length - 1; k >= 0; k--) {
      const { start, length } = segments[k];
      const name = `rev_${String(names.length).padStart(4, '0')}.mov`;
      // -t 必须写在 -i 前面：reverse 只在输入结束时才输出，写在输出端会把后面的整个文件都读进内存
      const args = ['-ss', sec(start), '-t', sec(length), '-i', input];
      if (v) {
        args.push('-map', '0:V:0', '-vf', ['reverse', ...evenSizeFilters(media)].join(','));
        args.push(...VIDEO_ENCODE);
      }
      if (reverseAudio) {
        // 音轨比画面短时先补静音到本段长度再倒放，否则倒放后声音会整体提前
        args.push('-map', '0:a:0', '-af', `apad=whole_dur=${sec(length)},areverse`);
        // 中间文件用 PCM，最后只编码一次 AAC，避免每段 AAC 的前导静音在拼接处累积
        args.push('-c:a', 'pcm_s16le');
      }
      args.push('-y', ctx.tempPath(name));
      const share = 1 - CONCAT_SHARE;
      await ctx.ffmpeg(args, {
        duration: length,
        range: [(done / total) * share, ((done + length) / total) * share],
      });
      done += length;
      names.push(name);
    }

    const list = ctx.tempPath('reverse.ffconcat');
    await fs.promises.writeFile(list, bareConcatList(names));
    const ext = reencodeExt(media);
    const output = ctx.outputPath(ext);
    const originalAudio = Boolean(v && media.audio) && params.audio === 'original';
    const args = ['-f', 'concat', '-safe', '0', '-i', list];
    if (originalAudio) args.push('-i', input);
    if (v) args.push('-map', '0:v:0', '-c:v', 'copy');
    if (originalAudio) args.push('-map', '1:a:0', ...copyAudioArgs(media), '-t', sec(total));
    if (reverseAudio) args.push('-map', '0:a:0', ...AUDIO_ENCODE);
    args.push(...FASTSTART, '-y', output);
    ctx.progress(1 - CONCAT_SHARE, { phase: 'merging' });
    await ctx.ffmpeg(args, { duration: total, range: [1 - CONCAT_SHARE, 1] });

    return {
      files: [output],
      data: { duration: Number(total.toFixed(3)), segments: segments.length },
    };
  },
});
