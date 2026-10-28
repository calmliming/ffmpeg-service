import { z } from 'zod';
import { enumParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { fitSampleRate, kbpsParam, probeAudio, rethrowWith, singleInput } from './format';
import {
  applyFilter,
  loudnessFields,
  measureLoudness,
  parseLoudnormJson,
  reportData,
  targetFrom,
  type LoudnormReport,
} from './loudnorm';

export const VIDEO_CONTAINERS = ['mp4', 'mkv', 'mov', 'webm'] as const;
type VideoContainer = (typeof VIDEO_CONTAINERS)[number];

// 画面直接复制，容器必须能装下原视频编码
const MP4_VIDEO = ['h264', 'hevc', 'av1', 'vp9', 'mpeg4', 'mpeg2video', 'mpeg1video', 'mjpeg'];
// FFmpeg 的 mov 封装器拒绝 VP9 / AV1（「vp9 only supported in MP4」），要等测量跑完、写文件头时才报错
const MOV_VIDEO = [
  ...MP4_VIDEO.filter((c) => c !== 'vp9' && c !== 'av1'),
  'prores',
  'dnxhd',
  'png',
  'qtrle',
  'rawvideo',
];
const WEBM_VIDEO = ['vp8', 'vp9', 'av1'];

const CONTAINERS: Record<VideoContainer, { muxer: string; videoCodecs?: string[] }> = {
  mp4: { muxer: 'mp4', videoCodecs: MP4_VIDEO },
  mov: { muxer: 'mov', videoCodecs: MOV_VIDEO },
  mkv: { muxer: 'matroska' },
  webm: { muxer: 'webm', videoCodecs: WEBM_VIDEO },
};

/** 不指定 format 时尽量沿用输入的容器；mkv 能装任何编码，是最后的退路 */
export function pickContainer(raw: Record<string, unknown>, videoCodec: string): VideoContainer {
  const format = raw.format as { format_name?: unknown; tags?: { major_brand?: unknown } };
  const names = typeof format?.format_name === 'string' ? format.format_name.split(',') : [];
  const brand = typeof format?.tags?.major_brand === 'string' ? format.tags.major_brand.trim() : '';
  const streams = Array.isArray(raw.streams)
    ? (raw.streams as { codec_type?: unknown; codec_name?: unknown }[])
    : [];
  const audioCodec = streams.find((s) => s.codec_type === 'audio')?.codec_name;

  if (names.includes('mov') || names.includes('mp4')) {
    if (brand === 'qt' && MOV_VIDEO.includes(videoCodec)) return 'mov';
    if (MP4_VIDEO.includes(videoCodec)) return 'mp4';
    if (MOV_VIDEO.includes(videoCodec)) return 'mov';
    return 'mkv';
  }
  if (names.includes('matroska') || names.includes('webm')) {
    // ffprobe 不区分 mkv 和 webm，只有画面和声音都是 webm 允许的编码时才当作 webm
    const webmAudio = audioCodec === 'opus' || audioCodec === 'vorbis';
    return WEBM_VIDEO.includes(videoCodec) && webmAudio ? 'webm' : 'mkv';
  }
  return MP4_VIDEO.includes(videoCodec) ? 'mp4' : 'mkv';
}

export function containerProblem(format: VideoContainer, videoCodec: string): string | undefined {
  const allowed = CONTAINERS[format].videoCodecs;
  if (!allowed || allowed.includes(videoCodec)) return undefined;
  return `视频编码 ${videoCodec || '未知'} 不能直接复制进 ${format} 容器（${format} 支持 ${allowed.join(' / ')}），请改用 mkv`;
}

export const normalizeVideoAudioOperation = defineOperation({
  name: 'video.normalize-audio',
  route: '/api/video/normalize-audio',
  title: '视频响度标准化',
  description:
    '对视频的音轨做 EBU R128 两遍响度标准化，画面直接复制不重新编码，适合统一一批视频的音量。',
  inputs: [{ name: 'file', kind: 'video', required: true, description: '带音轨的视频文件' }],
  chainable: true,
  params: z.object({
    ...loudnessFields,
    format: enumParam('format', VIDEO_CONTAINERS).optional().meta({
      description:
        '输出容器：mp4 / mkv / mov / webm。不传时沿用输入的容器（按内容识别），原画面编码放不进去时用 mkv',
    }),
    audioBitrate: kbpsParam('audioBitrate').optional().meta({
      description: '音频码率，如 128k、192k（8k-512k），默认 AAC 192k、webm 的 Opus 128k',
    }),
  }),
  example: [
    'curl -X POST http://localhost:9527/api/video/normalize-audio -F "file=@vlog.mp4" -F "targetLufs=-14"',
    '',
    'curl -X POST http://localhost:9527/api/video/normalize-audio -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/clip.mp4", "targetLufs": -16, "truePeak": -1.5}\'',
  ].join('\n'),
  notes: [
    '画面流直接复制（-c:v copy），只重新编码音频：mp4 / mov / mkv 用 AAC，webm 用 Opus（48 kHz）',
    '只保留第一条视频流和第一条音轨，字幕、其它音轨和数据流不保留',
    '容器必须能装下原画面编码：mp4 支持 H.264 / H.265 / AV1 / VP9 等，mov 另外支持 ProRes / DNxHD 等但不支持 VP9 / AV1，webm 只支持 VP8 / VP9 / AV1，mkv 都支持；不兼容时在处理前直接返回明确的错误',
    'H.265 放进 mp4 / mov 时打上 hvc1 标签，苹果设备可以直接播放',
    '任务结果 data 与 /api/audio/normalize 相同（target、input、output、normalizationType），另加 format',
    '没有画面的文件请用 /api/audio/normalize；没有音轨的视频会直接失败；音轨几乎静音或短于 0.4 秒（测不出 EBU R128 综合响度）时任务失败并说明原因',
  ],
  async run(ctx, params) {
    const file = singleInput(ctx);
    const media = await probeAudio(ctx, file, '输入视频');
    if (!media.video) throw new Error('输入文件没有视频画面，纯音频请用 /api/audio/normalize');
    const videoCodec = media.video.codec;

    const format = params.format ?? pickContainer(media.raw, videoCodec);
    const problem = containerProblem(format, videoCodec);
    if (problem) throw new Error(problem);

    const target = targetFrom(params);
    ctx.progress(0, { phase: 'analyzing' });
    const measured = await measureLoudness(ctx, file, target, {
      duration: media.duration,
      range: [0, 0.4],
    });

    const webm = format === 'webm';
    const sampleRate = webm ? 48000 : fitSampleRate('m4a', media.audio.sampleRate);
    const maxKbps = webm ? (media.audio.channels === 1 ? 256 : 510) : 512;
    const kbps = Math.round(Math.min(params.audioBitrate ?? (webm ? 128 : 192), maxKbps));
    const isoBased = format === 'mp4' || format === 'mov';
    const output = ctx.outputPath(format);
    const args = [
      '-i',
      file,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      ...(isoBased && videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      '-af',
      applyFilter(target, measured),
      '-c:a',
      webm ? 'libopus' : 'aac',
      '-b:a',
      `${kbps}k`,
      '-ar',
      String(sampleRate),
      ...(isoBased ? ['-movflags', '+faststart'] : []),
      '-f',
      CONTAINERS[format].muxer,
      '-map_metadata',
      '0',
      '-y',
      output,
    ];

    ctx.progress(0.4, { phase: 'processing' });
    const { stderr } = await ctx
      .ffmpeg(args, {
        duration: media.duration,
        range: [0.4, 1],
        logLevel: 'info',
        captureStderr: true,
      })
      .catch(rethrowWith(ctx, '视频响度标准化失败'));
    let final: LoudnormReport | undefined;
    try {
      final = parseLoudnormJson(stderr);
    } catch {
      // 第二遍没打印结果时只返回第一遍的测量值，不影响产物
    }

    return { files: [output], data: { format, ...reportData(target, measured, final) } };
  },
});
