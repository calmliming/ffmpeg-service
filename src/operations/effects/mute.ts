import { z } from 'zod';
import { defineOperation } from '../types';
import { VIDEO_INPUT, inspectVideo, type VideoInput } from './shared';

// 各容器能流复制进去的画面编码。判断依据是 ffprobe 的结果，不看扩展名（URL 下载的文件扩展名不可信）
const MP4_VIDEO = new Set([
  'h264',
  'hevc',
  'av1',
  'vp9',
  'mpeg4',
  'mpeg2video',
  'mpeg1video',
  'mjpeg',
]);
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);

export type MuteContainer = 'mp4' | 'mov' | 'mkv' | 'webm';

/**
 * 尽量沿用原容器：mp4 / mov / mkv / webm 保持不变；avi、flv、ts 等其他容器能装进 mp4 就转 mp4，
 * 否则用几乎什么编码都能装的 mkv，保证流复制不会因为容器不支持编码而失败
 */
export function muteContainer(
  input: Pick<VideoInput, 'formatName' | 'majorBrand' | 'videoCodec'>,
): MuteContainer {
  const formats = input.formatName.split(',');
  const codec = input.videoCodec;
  // mov 和 mp4 的 format_name 相同，靠 ftyp 的 major_brand 区分
  if (formats.includes('mov') || formats.includes('mp4')) {
    return input.majorBrand === 'qt' || !MP4_VIDEO.has(codec) ? 'mov' : 'mp4';
  }
  // matroska 和 webm 的 format_name 也相同；webm 能装的编码就输出 webm，浏览器可以直接播放
  if (formats.includes('matroska') || formats.includes('webm')) {
    return WEBM_VIDEO.has(codec) ? 'webm' : 'mkv';
  }
  return MP4_VIDEO.has(codec) ? 'mp4' : 'mkv';
}

export const mute = defineOperation({
  name: 'video.mute',
  route: '/api/video/mute',
  title: '去除音轨',
  description: '删除视频里的全部音轨，画面流复制不重新编码，速度快且画质无损。',
  inputs: VIDEO_INPUT,
  params: z.object({}),
  chainable: true,
  example: 'curl -X POST http://localhost:9527/api/video/mute -F "file=@input.mp4"',
  notes: [
    '画面直接流复制，不重新编码；只保留主画面流，音轨、字幕、封面图和数据流都会去掉。',
    '容器尽量保持不变：mp4、mov、mkv、webm 原样输出（matroska 里是 VP8 / VP9 / AV1 时输出 webm）；avi、flv、ts 等其他容器在编码允许时转为 mp4，否则输出 mkv。',
    '输入没有音轨时同样成功，相当于只做一次封装转换。',
  ],
  async run(ctx) {
    const input = await inspectVideo(ctx, ctx.inputs.file[0]);
    const container = muteContainer(input);
    const output = ctx.outputPath(container);
    const args = ['-i', input.file, '-map', `0:${input.videoIndex}`, '-c', 'copy'];
    // moov 放到文件头，浏览器拿到链接可以边下边播
    if (container === 'mp4' || container === 'mov') args.push('-movflags', '+faststart');
    args.push('-y', output);
    await ctx.ffmpeg(args, { duration: input.duration }).catch((err: Error) => {
      if (ctx.signal.aborted) throw err;
      throw new Error(`去除音轨失败（画面编码 ${input.videoCodec || '未知'}）: ${err.message}`);
    });
    return {
      files: [output],
      data: { container, removedAudioTracks: input.audioCodecs.length },
    };
  },
});
