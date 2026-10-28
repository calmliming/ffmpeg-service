import { z } from 'zod';
import { enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  FADE_CURVE_NOTE,
  FADE_CURVES,
  decodedDuration,
  encodeAudio,
  fitSampleRate,
  mapLimit,
  num,
  outputFields,
  probeAudio,
  outputFormat,
  type AudioMedia,
} from './format';

export const MAX_CONCAT_FILES = 50;

export interface MixTarget {
  sampleRate: number;
  channels: 1 | 2;
}

/** 统一成同一采样率和声道布局：取输入里最高的采样率（再按输出格式调整），任一输入是多声道就用立体声 */
export function pickMixTarget(items: AudioMedia[], fit: (rate: number) => number): MixTarget {
  const maxRate = Math.max(...items.map((m) => m.audio.sampleRate || 0));
  return {
    sampleRate: fit(maxRate > 0 ? maxRate : 48000),
    channels: items.some((m) => m.audio.channels >= 2) ? 2 : 1,
  };
}

/**
 * 每个输入统一格式的滤镜链，时间戳从 0 开始，concat / acrossfade 才能首尾相接。
 * 单声道转立体声时直接复制到两个声道：FFmpeg 默认按恒功率把两边各降 3 dB，
 * 而播放器放单声道文件是两边都满音量，降了会比原文件听起来小
 */
export function conformChain(index: number, target: MixTarget, inputChannels: number): string {
  const layout = target.channels === 2 ? 'stereo' : 'mono';
  const upmix = target.channels === 2 && inputChannels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '';
  return (
    `[${index}:a:0]${upmix}aresample=${target.sampleRate},` +
    `aformat=sample_fmts=fltp:channel_layouts=${layout},asetpts=PTS-STARTPTS`
  );
}

/** inputChannels：每个输入的声道数，决定是否需要单声道复制成立体声 */
export function concatGraph(
  inputChannels: readonly number[],
  target: MixTarget,
  crossfade: number,
  curve: string,
): string {
  const count = inputChannels.length;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(`${conformChain(i, target, inputChannels[i])}[a${i}]`);
  }
  if (crossfade <= 0) {
    const labels = Array.from({ length: count }, (_, i) => `[a${i}]`).join('');
    parts.push(`${labels}concat=n=${count}:v=0:a=1[out]`);
  } else {
    // 两两串联 acrossfade，兼容所有 FFmpeg 版本（多输入的 acrossfade 是新版本才有的）
    let prev = 'a0';
    for (let i = 1; i < count; i++) {
      const label = i === count - 1 ? 'out' : `x${i}`;
      parts.push(
        `[${prev}][a${i}]acrossfade=d=${num(crossfade)}:c1=${curve}:c2=${curve}[${label}]`,
      );
      prev = label;
    }
  }
  return parts.join(';');
}

export const concatAudioOperation = defineOperation({
  name: 'audio.concat',
  route: '/api/audio/concat',
  title: '音频拼接',
  description:
    '把多个音频首尾相连拼成一个文件，可以在相邻两段之间做交叉淡化；采样率、声道、格式不同的文件也能直接拼。',
  inputs: [
    {
      name: 'files',
      kind: 'media',
      required: true,
      multiple: { min: 2, max: MAX_CONCAT_FILES },
      description: `按顺序拼接的音频（或带音轨的视频），2-${MAX_CONCAT_FILES} 个`,
    },
  ],
  params: z.object({
    crossfade: numberParam('crossfade', { min: 0, max: 30 })
      .default(0)
      .meta({ description: '相邻两段交叉淡化的秒数（0-30），0 表示直接拼接（默认）' }),
    curve: enumParam('curve', FADE_CURVES)
      .default('tri')
      .meta({ description: `交叉淡化曲线，默认 tri（线性）。${FADE_CURVE_NOTE}` }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/concat -F "files=@intro.mp3" -F "files=@main.wav" -F "files=@outro.m4a" -F "crossfade=1.5"',
    '',
    'curl -X POST http://localhost:9527/api/audio/concat -H "Content-Type: application/json" \\',
    '  -d \'{"filesUrls": ["https://example.com/a.mp3", "https://example.com/b.mp3"], "format": "mp3"}\'',
  ].join('\n'),
  notes: [
    `2-${MAX_CONCAT_FILES} 个文件，按上传 / URL 列表的顺序拼接；视频文件只取第一条音轨`,
    '所有输入先统一成相同的采样率（输入中最高的，输出格式不支持时取最接近的）和声道（任一输入是多声道就输出立体声），再拼接；单声道输入原样复制到左右声道，音量不变，5.1 等多声道输入按 FFmpeg 标准方式缩混为立体声',
    'crossfade > 0 时相邻两段重叠 crossfade 秒，总时长 = 各段之和 - (n-1) × crossfade；每个文件都必须比 crossfade 长',
    '不传 format 时沿用第 1 个文件的格式（不是可输出的音频格式时用 mp3）',
    '有输入没有时长信息（管道写出的 webm、浏览器 MediaRecorder 录音）时编码中不汇报细分进度，任务结果 data.duration 取实际输出的长度',
  ],
  async run(ctx, params) {
    const files = ctx.inputs.files ?? [];
    if (files.length < 2) throw new Error('至少需要 2 个音频文件');

    ctx.progress(0, { phase: 'analyzing' });
    const items = await mapLimit(files, 4, (file, i) =>
      probeAudio(ctx, file, `第 ${i + 1} 个文件`),
    );
    if (params.crossfade > 0) {
      items.forEach((m, i) => {
        if (m.audioDuration > 0 && m.audioDuration <= params.crossfade) {
          throw new Error(
            `第 ${i + 1} 个文件只有 ${num(m.audioDuration, 3)} 秒，不比 crossfade（${num(params.crossfade, 3)} 秒）长`,
          );
        }
      });
    }

    const format = outputFormat(items[0], params.format);
    const target = pickMixTarget(items, (rate) => fitSampleRate(format, rate));
    const total =
      items.reduce((sum, m) => sum + m.audioDuration, 0) - (files.length - 1) * params.crossfade;
    // 有输入拿不到时长（管道写出的 webm、MediaRecorder 录音）时算出的总长偏短：
    // 不按它汇报进度，结果里的 duration 改用编码统计里实际输出的长度
    const known = items.every((m) => m.audioDuration > 0);
    let measured: number | undefined;

    ctx.progress(0, { phase: 'merging' });
    const output = await encodeAudio(ctx, {
      inputs: files,
      filterComplex: concatGraph(
        items.map((m) => m.audio.channels),
        target,
        params.crossfade,
        params.curve,
      ),
      encode: { format, bitrate: params.bitrate, inputChannels: target.channels },
      duration: known && total > 0 ? total : undefined,
      errorPrefix: '音频拼接失败',
      ...(known ? {} : { onStderr: (stderr: string) => (measured = decodedDuration(stderr)) }),
    });
    const duration = known ? total : (measured ?? total);
    return {
      files: [output],
      data: {
        inputs: files.length,
        duration: Math.round(Math.max(0, duration) * 1000) / 1000,
        sampleRate: target.sampleRate,
        channels: target.channels,
      },
    };
  },
});
