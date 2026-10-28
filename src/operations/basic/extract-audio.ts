import { z } from 'zod';
import { defineOperation } from '../types';
import { bitrateParam, booleanParam, numberParam } from '../../schemas/coerce';
import { AUDIO_CONTAINERS, CONTAINERS, formatParam, isAudioCodec } from './formats';
import { audioBitrateProblem, audioEncoderArgs, muxerArgs, sampleRateProblem } from './encode';
import { inspectInput } from './probe';

const params = z.object({
  format: formatParam('format', AUDIO_CONTAINERS)
    .default('mp3')
    .meta({ description: `音频格式，默认 mp3。可选 ${AUDIO_CONTAINERS.join('、')}` }),
  bitrate: bitrateParam('bitrate').optional().meta({
    description:
      '音频码率，如 128k、320k（不带单位时小于 10000 按 kbps，128 即 128k）。默认 mp3 / aac / m4a 为 192k，opus 为 128k；wav / flac 是无损格式，忽略此参数',
  }),
  sampleRate: numberParam('sampleRate', { min: 8000, max: 192000, int: true }).optional().meta({
    description: '采样率（Hz），如 44100、48000。默认保持原采样率（格式不支持时自动换算）',
  }),
  channels: numberParam('channels', { min: 1, max: 2, int: true })
    .optional()
    .meta({ description: '声道数：1（单声道）或 2（立体声），默认保持原声道' }),
  track: numberParam('track', { min: 0, max: 63, int: true })
    .default(0)
    .meta({ description: '提取第几路音轨（从 0 开始），多语言视频可以选择配音，默认 0' }),
  copy: booleanParam('copy').default(false).meta({
    description:
      '直接复制音频流、不重新编码（无损且很快），要求源音频编码与目标格式一致（如 aac 源提取为 m4a / aac）；默认 false',
  }),
});

export const extractAudio = defineOperation({
  name: 'extract-audio',
  route: '/api/edit/extract-audio',
  title: '提取音频',
  description: '从视频（或其他音频）中提取一路音轨，输出为 mp3、aac、m4a、wav、flac、ogg 或 opus。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '带音轨的视频或音频文件' }],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/edit/extract-audio \\',
    '  -F "file=@video.mp4" -F "format=wav" -F "sampleRate=16000" -F "channels=1"',
    '',
    '# 用 URL 提交，不重新编码直接取出 AAC 音轨',
    'curl -X POST http://localhost:9527/api/edit/extract-audio -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","format":"m4a","copy":true}\'',
  ].join('\n'),
  notes: [
    '编码：mp3 = libmp3lame，aac（ADTS 裸流）/ m4a = aac，wav = pcm_s16le，flac = flac，ogg = vorbis，opus = libopus。',
    'copy=true 时源编码必须与格式对应：aac → aac / m4a，mp3 → mp3，opus → opus / ogg，vorbis / flac → ogg，flac → flac，pcm_s16le / pcm_s24le → wav，alac → m4a；不对应时任务失败。',
    '采样率按编码器限制校验：mp3 最高 48000，opus 只支持 8000 / 12000 / 16000 / 24000 / 48000。',
    '输入没有音轨时任务失败（输入文件没有音轨）；track 超出音轨数量时同样失败并提示实际数量。',
    '保留标题、歌手等全局元数据，不保留封面图。',
  ],
  check(p) {
    const spec = CONTAINERS[p.format];
    if (p.copy) {
      const conflicts = [
        p.bitrate && 'bitrate',
        p.sampleRate && 'sampleRate',
        p.channels && 'channels',
      ].filter(Boolean);
      if (conflicts.length) return `copy=true 直接复制音频流，不能同时设置 ${conflicts.join('、')}`;
      return undefined;
    }
    const codec = spec.defaultAudio;
    return (
      (p.bitrate ? audioBitrateProblem('bitrate', codec, p.bitrate) : undefined) ??
      (p.sampleRate ? sampleRateProblem(codec, p.sampleRate) : undefined)
    );
  },

  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await inspectInput(ctx, file);
    if (!info.media.audio) throw new Error('输入文件没有音轨');
    if (p.track >= info.audioStreams) {
      throw new Error(
        `输入文件只有 ${info.audioStreams} 路音轨，track 最大为 ${info.audioStreams - 1}`,
      );
    }
    const spec = CONTAINERS[p.format];

    const out = ctx.outputPath(p.format);
    const args = ['-i', file, '-map', `0:a:${p.track}`];
    if (p.copy) {
      const codec = info.audioCodecs[p.track];
      if (!isAudioCodec(codec) || !spec.audio.includes(codec)) {
        throw new Error(
          `源音频编码是 ${codec}，不能直接复制为 ${p.format}（需要 ${spec.audio.join(' / ')}），请去掉 copy 重新编码`,
        );
      }
      args.push('-c:a', 'copy');
    } else {
      args.push(
        ...audioEncoderArgs({
          codec: spec.defaultAudio,
          bitrate: p.bitrate,
          sampleRate: p.sampleRate,
          channels: p.channels,
        }),
      );
    }
    args.push(...muxerArgs(spec), '-y', out);

    await ctx.ffmpeg(args, { duration: info.media.duration });
    return { files: [out] };
  },
});
