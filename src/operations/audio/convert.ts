import fs from 'fs';
import { z } from 'zod';
import { numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  encodeAudio,
  errorMessage,
  formatSpec,
  outputFields,
  prepareSingle,
  sampleRateParam,
  sampleRateProblem,
} from './format';

export const convertOperation = defineOperation({
  name: 'audio.convert',
  route: '/api/audio/convert',
  title: '音频格式转换',
  description:
    '把音频文件或视频里的音轨转换成 mp3 / m4a / aac / wav / flac / ogg / opus，可以同时调整码率、采样率和声道数。',
  inputs: [
    {
      name: 'file',
      kind: 'media',
      required: true,
      description: '音频文件，或带音轨的视频（使用第一条音轨）',
    },
  ],
  chainable: true,
  params: z.object({
    ...outputFields,
    sampleRate: sampleRateParam('sampleRate').optional().meta({
      description:
        '输出采样率（Hz）：8000 / 11025 / 16000 / 22050 / 24000 / 32000 / 44100 / 48000 / 88200 / 96000，不传时保持原采样率（编码器不支持时自动换成最接近的）',
    }),
    channels: numberParam('channels', { min: 1, max: 2, int: true }).optional().meta({
      description:
        '输出声道数：1 单声道、2 立体声，不传时保持原声道（多声道会按编码器能力自动混缩）；单声道转立体声时两个声道音量与原文件相同',
    }),
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/convert -F "file=@song.wav" -F "format=mp3" -F "bitrate=320k"',
    '',
    '# 从视频里提取音轨（编码相同时直接复制，不重新编码）',
    'curl -X POST http://localhost:9527/api/audio/convert -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/video.mp4", "format": "m4a"}\'',
  ].join('\n'),
  notes: [
    '输入可以是任何带音轨的音视频文件，格式按文件内容识别，不看扩展名；视频只取第一条音轨',
    '编码器：mp3 用 libmp3lame，m4a / aac 用 AAC，ogg 用 Vorbis，opus 用 libopus，flac 无损，wav 为 16 位 PCM',
    '目标编码和输入相同、且没有指定 bitrate / sampleRate / channels 时直接复制音频流，不重新编码（例如从 mp4 视频提取 m4a），结果的 data.copied 为 true',
    'mp3 不支持 88200 / 96000 Hz；opus 只支持 8000 / 16000 / 24000 / 48000 Hz',
    '码率超过编码器上限时按上限编码（mp3 320k，opus 510k、单声道 256k）；ogg 的码率会换算成 Vorbis VBR 质量等级',
    '会保留标题、歌手等全局元数据，不保留封面图',
  ],
  check(params) {
    if (params.format) return sampleRateProblem(params.format, params.sampleRate);
    return undefined;
  },
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format, params.sampleRate);
    const spec = formatSpec(format);
    const untouched =
      params.sampleRate === undefined &&
      params.channels === undefined &&
      (spec.lossless || params.bitrate === undefined);

    if (untouched && media.audio.codec === spec.codecName) {
      const output = ctx.outputPath(format);
      try {
        await ctx.ffmpeg(
          [
            '-i',
            file,
            '-map',
            '0:a:0',
            '-c:a',
            'copy',
            ...spec.extra,
            '-f',
            spec.muxer,
            '-map_metadata',
            '0',
            '-y',
            output,
          ],
          { duration: media.audioDuration },
        );
        return { files: [output], data: { format, codec: spec.codecName, copied: true } };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        // 少数文件的时间戳或封装参数不适合直接复制，退回重新编码
        await fs.promises.rm(output, { force: true }).catch(() => {});
        ctx.log(`音频流复制失败，改为重新编码: ${errorMessage(err)}`);
      }
    }

    // 单声道转立体声直接复制到两个声道；-ac 2 默认按恒功率两边各降 3 dB，听起来比原文件小
    const upmix = params.channels === 2 && media.audio.channels === 1;
    const output = await encodeAudio(ctx, {
      inputs: [file],
      filter: upmix ? 'pan=stereo|c0=c0|c1=c0' : undefined,
      encode: {
        format,
        bitrate: params.bitrate,
        sampleRate: params.sampleRate,
        channels: params.channels,
        inputChannels: media.audio.channels,
      },
      duration: media.audioDuration,
      errorPrefix: '音频转换失败',
    });
    return { files: [output], data: { format, codec: spec.codecName, copied: false } };
  },
});
