import { z } from 'zod';
import { defineOperation } from '../types';
import { encodeAudio, fitSampleRate, outputFields, prepareSingle } from './format';
import {
  applyFilter,
  loudnessFields,
  measureLoudness,
  parseLoudnormJson,
  reportData,
  targetFrom,
  type LoudnormReport,
} from './loudnorm';

export const normalizeOperation = defineOperation({
  name: 'audio.normalize',
  route: '/api/audio/normalize',
  title: '响度标准化',
  description:
    '按 EBU R128 做两遍响度标准化：第一遍测量综合响度、真峰值和响度范围，第二遍按测量值做线性增益，让不同来源的音频听起来一样响。',
  inputs: [
    {
      name: 'file',
      kind: 'media',
      required: true,
      description: '音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频）',
    },
  ],
  chainable: true,
  params: z.object({ ...loudnessFields, ...outputFields }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/normalize -F "file=@podcast.mp3" -F "targetLufs=-16"',
    '',
    'curl -X POST http://localhost:9527/api/audio/normalize -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/song.flac", "targetLufs": -14, "truePeak": -1, "format": "m4a"}\'',
  ].join('\n'),
  notes: [
    '两遍 loudnorm：第一遍只测量（进度 0-40%），第二遍带 measured_* 和 linear=true 输出（40-100%）',
    '任务结果 data 包含 target、input（原始的 i / tp / lra / thresh）、output（输出的实测值）和 normalizationType',
    'normalizationType 为 linear 表示整体线性增益、不改变动态；当达到目标响度会超过 truePeak，或原始响度范围大于 lra 时，FFmpeg 会退回 dynamic（动态压缩）',
    'loudnorm 内部按 192 kHz 处理，输出会还原为输入的采样率（目标格式不支持时取最接近的）',
    '几乎静音（综合响度低于 -70 LUFS）的输入无法标准化，任务会失败并说明原因；短于 0.4 秒的音频（如短音效）凑不满一个 EBU R128 测量块，测不出综合响度，同样会失败',
    '视频请用 /api/video/normalize-audio，画面直接复制',
  ],
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);
    const target = targetFrom(params);

    ctx.progress(0, { phase: 'analyzing' });
    const measured = await measureLoudness(ctx, file, target, {
      duration: media.audioDuration,
      range: [0, 0.4],
    });

    ctx.progress(0.4, { phase: 'processing' });
    let final: LoudnormReport | undefined;
    const output = await encodeAudio(ctx, {
      inputs: [file],
      filter: applyFilter(target, measured),
      encode: {
        format,
        bitrate: params.bitrate,
        sampleRate: fitSampleRate(format, media.audio.sampleRate),
        inputChannels: media.audio.channels,
      },
      duration: media.audioDuration,
      range: [0.4, 1],
      errorPrefix: '响度标准化失败',
      onStderr: (stderr) => {
        try {
          final = parseLoudnormJson(stderr);
        } catch {
          // 第二遍没打印结果时只返回第一遍的测量值，不影响产物
        }
      },
    });

    return { files: [output], data: reportData(target, measured, final) };
  },
});
