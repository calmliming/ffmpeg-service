import { z } from 'zod';
import { defineOperation } from '../types';
import {
  bitrateParam,
  booleanParam,
  colorParam,
  enumParam,
  numberParam,
} from '../../schemas/coerce';
import {
  AUDIO_CONTAINERS,
  CONTAINERS,
  VIDEO_CONTAINERS,
  audioCodecParam,
  audioCodecProblem,
  formatParam,
  isAudioCodec,
  isAudioContainer,
  isVideoCodec,
  videoCodecParam,
  videoCodecProblem,
  videoVariant,
  type AudioCodec,
  type Container,
  type VideoCodec,
} from './formats';
import {
  audioBitrateProblem,
  audioEncoderArgs,
  crfProblem,
  fitAudioLimits,
  isMpegVideo,
  mpegFpsProblem,
  muxerArgs,
  nearestMpegFps,
  parseFrameRate,
  presetParam,
  sampleRateProblem,
  supportsPreset,
  videoBitrateProblem,
  videoEncoderArgs,
} from './encode';
import { expectedSize, resolutionParam, scaleFilters, sizeProblem } from './resolution';
import { inspectInput, type InputInfo } from './probe';

const ALL_FORMATS = [...VIDEO_CONTAINERS, ...AUDIO_CONTAINERS] as const;
const FORMAT_HINT = `${VIDEO_CONTAINERS.join(' / ')}（视频）或 ${AUDIO_CONTAINERS.join(' / ')}（纯音频）`;

// 旧版 format 不设限，有人拿 transcode 转动图
const ANIMATED_REDIRECT = Object.fromEntries(
  ['gif', 'webp', 'apng'].map((f) => [f, `转 ${f} 动图请用 /api/process/gif（format=${f}）`]),
);

const params = z.object({
  format: formatParam('format', ALL_FORMATS, FORMAT_HINT, ANIMATED_REDIRECT)
    .default('mp4')
    .meta({
      description: `输出格式，默认 mp4。视频：${VIDEO_CONTAINERS.join('、')}；纯音频（丢弃画面）：${AUDIO_CONTAINERS.join('、')}，其中 ogg 遇到有画面的输入输出 Ogg 视频（theora + vorbis，同 ogv，兼容旧版）。也接受 mpeg、matroska、asf 等别名`,
    }),
  videoCodec: videoCodecParam('videoCodec').optional().meta({
    description:
      '视频编码：h264、h265（hevc）、vp9、vp8、av1、mpeg4、mpeg2video、mpeg1video、theora、wmv2 或 copy（直接复制不重新编码）。也接受 libx264 这类编码器名。默认按格式选择（mp4 为 h264，webm 为 vp9）',
  }),
  audioCodec: audioCodecParam('audioCodec').optional().meta({
    description:
      '音频编码：aac、mp3、opus、vorbis、flac、alac、ac3、mp2、pcm_s16le、pcm_s24le、wmav2 或 copy。也接受 libmp3lame 这类编码器名。默认按格式选择（mp4 为 aac，webm 为 opus）',
  }),
  videoBitrate: bitrateParam('videoBitrate').optional().meta({
    description:
      '视频码率，如 1000k、2.5M（10k-200M）。不带单位时小于 10000 按 kbps（兼容旧版，1000 即 1000k），否则按 bit/s。单独设置时为平均码率；与 crf 同时设置时作为码率上限',
  }),
  audioBitrate: bitrateParam('audioBitrate').optional().meta({
    description:
      '音频码率，如 128k（不带单位的规则同 videoBitrate，128 即 128k）。默认 aac / mp3 / ac3 / mp2 为 192k，opus 为 128k；无损编码忽略',
  }),
  resolution: resolutionParam('resolution').optional().meta({
    description:
      '输出分辨率：1280x720（按 fit 适配）、1280x?（宽 1280，高按比例）、?x720 或 50%。每边不超过 7680，奇数自动取偶数',
  }),
  fit: enumParam('fit', ['contain', 'cover', 'stretch'] as const)
    .optional()
    .meta({
      description:
        'resolution 为 宽x高 时画面比例不一致的处理：contain（默认，完整显示并补边）、cover（铺满并裁掉多余部分）、stretch（拉伸变形）',
    }),
  padColor: colorParam('padColor')
    .optional()
    .meta({ description: 'fit=contain 时补边的颜色，默认 black；支持颜色名、#RRGGBB' }),
  fps: numberParam('fps', { min: 1, max: 120 })
    .optional()
    .meta({ description: '输出帧率，1-120，可带小数（如 29.97）。默认保持原帧率' }),
  crf: numberParam('crf', { min: 0, max: 63, int: true }).optional().meta({
    description:
      '恒定质量，越小画质越好文件越大。h264 / h265 为 0-51（默认 23 / 28），vp9 / av1 为 0-63（默认 31 / 35），vp8 为 4-63',
  }),
  preset: presetParam('preset').optional().meta({
    description:
      '编码速度：ultrafast、superfast、veryfast（默认）、faster、fast、medium、slow、slower、veryslow。越慢压缩率越高；vp8 / vp9 / av1 自动换算成各自的速度档位',
  }),
  noAudio: booleanParam('noAudio')
    .default(false)
    .meta({ description: '去掉音轨，只输出画面，默认 false' }),
  sampleRate: numberParam('sampleRate', { min: 8000, max: 192000, int: true }).optional().meta({
    description: '音频采样率（Hz），如 44100、48000。默认保持原采样率（编码器不支持时自动换算）',
  }),
  channels: numberParam('channels', { min: 1, max: 2, int: true })
    .optional()
    .meta({ description: '声道数：1（单声道）或 2（立体声）。默认保持原声道' }),
  stripMetadata: booleanParam('stripMetadata')
    .default(false)
    .meta({ description: '去掉标题、拍摄时间、GPS 位置等元数据和章节，默认 false（保留）' }),
});

type Params = z.output<typeof params>;

const named = (pairs: [string, unknown][]) =>
  pairs.filter(([, value]) => value !== undefined).map(([name]) => name);

function resolveVideoCodec(p: Params): VideoCodec | undefined {
  if (p.videoCodec === 'copy') return undefined;
  return p.videoCodec ?? CONTAINERS[videoVariant(p.format)].defaultVideo;
}

function resolveAudioCodec(p: Params): AudioCodec | undefined {
  if (p.audioCodec === 'copy' || p.noAudio) return undefined;
  return p.audioCodec ?? CONTAINERS[p.format].defaultAudio;
}

// FLV 头里的 MP3 采样率只能表示 11025 / 22050 / 44100
const FLV_MP3_RATES = [11025, 22050, 44100];

function check(p: Params): string | undefined {
  const { format } = p;
  // ogg 能装画面（输入有画面时按 ogv 输出），画面相关参数按 ogv 的规则检查
  const videoFormat = videoVariant(format);
  const videoFields = named([
    ['videoCodec', p.videoCodec],
    ['videoBitrate', p.videoBitrate],
    ['resolution', p.resolution],
    ['fit', p.fit],
    ['padColor', p.padColor],
    ['fps', p.fps],
    ['crf', p.crf],
    ['preset', p.preset],
  ]);

  if (isAudioContainer(videoFormat)) {
    if (videoFields.length) return `${format} 是纯音频格式，不能设置 ${videoFields.join('、')}`;
    if (p.noAudio) return `${format} 是纯音频格式，不能设置 noAudio`;
  }

  if (p.videoCodec === 'copy') {
    const conflicts = named([
      ['videoBitrate', p.videoBitrate],
      ['resolution', p.resolution],
      ['fit', p.fit],
      ['padColor', p.padColor],
      ['fps', p.fps],
      ['crf', p.crf],
      ['preset', p.preset],
    ]);
    if (conflicts.length) {
      return `videoCodec=copy 直接复制视频流、不重新编码，不能同时设置 ${conflicts.join('、')}`;
    }
  }

  if ((p.fit || p.padColor) && p.resolution?.kind !== 'fixed') {
    return 'fit 和 padColor 只在 resolution 为 宽x高（如 1280x720）时有效';
  }
  if (p.padColor && p.fit && p.fit !== 'contain') return 'padColor 只在 fit=contain 时有效';

  const vcodec = resolveVideoCodec(p);
  if (vcodec && !isAudioContainer(videoFormat)) {
    const problem =
      videoCodecProblem(videoFormat, vcodec, format) ??
      (p.crf !== undefined ? crfProblem(vcodec, p.crf) : undefined) ??
      (p.preset && !supportsPreset(vcodec) ? `${vcodec} 编码不支持 preset` : undefined) ??
      (p.videoBitrate ? videoBitrateProblem('videoBitrate', p.videoBitrate) : undefined) ??
      (p.fps ? mpegFpsProblem(vcodec, p.fps) : undefined);
    if (problem) return problem;
  }

  if (p.noAudio) {
    const conflicts = named([
      ['audioCodec', p.audioCodec],
      ['audioBitrate', p.audioBitrate],
      ['sampleRate', p.sampleRate],
      ['channels', p.channels],
    ]);
    if (conflicts.length) return `noAudio=true 时不能再设置 ${conflicts.join('、')}`;
  }

  if (p.audioCodec === 'copy') {
    const conflicts = named([
      ['audioBitrate', p.audioBitrate],
      ['sampleRate', p.sampleRate],
      ['channels', p.channels],
    ]);
    if (conflicts.length) {
      return `audioCodec=copy 直接复制音频流、不重新编码，不能同时设置 ${conflicts.join('、')}`;
    }
  }

  const acodec = resolveAudioCodec(p);
  if (acodec) {
    const problem =
      audioCodecProblem(format, acodec) ??
      (p.audioBitrate ? audioBitrateProblem('audioBitrate', acodec, p.audioBitrate) : undefined) ??
      (p.sampleRate ? sampleRateProblem(acodec, p.sampleRate) : undefined);
    if (problem) return problem;
    if (
      format === 'flv' &&
      acodec === 'mp3' &&
      p.sampleRate &&
      !FLV_MP3_RATES.includes(p.sampleRate)
    ) {
      return `flv 里的 mp3 只支持采样率 ${FLV_MP3_RATES.join(' / ')}`;
    }
  }
  return undefined;
}

/**
 * 流复制前确认源编码能放进目标容器，否则 FFmpeg 只会报一句英文的 Could not find tag。
 * 只拦截白名单里认识的编码；ProRes、DTS 这类不认识的编码交给 FFmpeg 尝试（mov 装 ProRes 本来就没问题）
 */
function copyProblem(
  kind: '视频' | '音频',
  container: Container,
  codec: string | undefined,
  label: string = container,
) {
  if (!codec || !(kind === '视频' ? isVideoCodec(codec) : isAudioCodec(codec))) return undefined;
  const spec = CONTAINERS[container];
  const allowed: readonly string[] = (kind === '视频' ? spec.video : spec.audio) ?? [];
  if (allowed.includes(codec)) return undefined;
  const name = kind === '视频' ? 'videoCodec' : 'audioCodec';
  return `源${kind}编码 ${codec} 不能直接复制到 ${label}，请去掉 ${name}=copy 或换一种输出格式`;
}

function buildVideoFilters(p: Params, info: InputInfo, codec: VideoCodec): string[] {
  const filters: string[] = [];
  let fps = p.fps ? String(p.fps) : undefined;
  if (!fps && isMpegVideo(codec)) {
    fps = nearestMpegFps(
      parseFrameRate(info.media.video?.avgFrameRate) || parseFrameRate(info.media.video?.frameRate),
    );
  }
  // 先降帧再缩放，少处理一些帧
  if (fps) filters.push(`fps=${fps}`);
  if (p.resolution) {
    filters.push(...scaleFilters(p.resolution, p.fit ?? 'contain', p.padColor));
  } else {
    const v = info.media.video;
    // x264 等编码器要求 yuv420p 的宽高都是偶数，奇数边的源先裁掉 1 像素
    if (v && (v.width % 2 || v.height % 2)) filters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');
  }
  return filters;
}

export const transcode = defineOperation({
  name: 'transcode',
  route: '/api/transcode',
  title: '转码 / 格式转换',
  description:
    '把音视频转换成另一种封装格式或编码，可同时调整分辨率、帧率、码率、质量和音频参数；输出纯音频格式时丢弃画面。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '要转换的视频或音频文件' }],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/transcode \\',
    '  -F "file=@video.mp4" -F "format=webm" -F "resolution=1280x?" -F "crf=32"',
    '',
    '# 用 URL 提交',
    'curl -X POST http://localhost:9527/api/transcode -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mov","format":"mp4","videoCodec":"h265","preset":"medium"}\'',
  ].join('\n'),
  notes: [
    'format 只接受白名单里的格式（旧版直接拼进文件名，存在路径穿越），大小写和开头的点会被忽略；mpeg→mpg、matroska→mkv 等别名自动换算。',
    '各格式允许的编码：mp4 = h264 / hevc / av1 / vp9 / mpeg4 + aac / mp3 / opus / flac / alac / ac3；mov = h264 / hevc / mpeg4 + aac / mp3 / alac / ac3 / pcm；m4v = h264 / hevc / mpeg4 + aac / alac / ac3；3gp = h264 / mpeg4 + aac；mkv = 全部；webm = vp9 / vp8 / av1 + opus / vorbis；avi = h264 / mpeg4 + mp3 / aac / ac3 / mp2 / pcm_s16le；flv = h264 + aac / mp3；ts = h264 / hevc / mpeg2video + aac / mp3 / mp2 / ac3 / opus；ogv = theora / vp8 + vorbis / opus / flac；mpg = mpeg2video / mpeg1video + mp2 / mp3 / ac3；wmv = wmv2 + wmav2。纯音频：mp3 = mp3，m4a = aac / alac，aac = aac，wav = pcm_s16le / pcm_s24le，flac = flac，ogg = vorbis / opus / flac，opus = opus。组合不合法时返回 400。',
    '默认编码：mp4 / mov / m4v / 3gp / mkv / flv / ts 为 h264 + aac，avi 为 h264 + mp3，webm 为 vp9 + opus，ogv 为 theora + vorbis，mpg 为 mpeg2video + mp2，wmv 为 wmv2（WMV8）+ wmav2。默认质量 h264 crf 23、h265 crf 28、vp9 crf 31、av1 crf 35，preset 为 veryfast。',
    'format=ogg 与旧版一致：输入有画面时输出 Ogg 视频（theora + vorbis，编码规则和可用参数同 ogv，扩展名仍是 .ogg）；输入只有音频时输出 vorbis 音频。只想从视频里取出 ogg 音频请用 /api/edit/extract-audio。',
    'wmv 输出 ASF 封装（旧版的 wmv 输出同样是 ASF），wmav2 最高 48 kHz、2 声道，源超出时自动降到 48 kHz / 立体声；asf 是 wmv 的别名。',
    '重新编码的画面统一输出 8 bit yuv420p（10 bit / 4:4:4 源也一样），保证浏览器和手机能播放；mp4 / mov 里的 HEVC 带 hvc1 标签，Apple 设备可直接播放。',
    '只保留第一路画面（不含封面图）和第一路音轨，字幕、数据流、附件不保留。',
    'resolution 为 宽x高 时默认 fit=contain（等比缩放后补黑边）。旧版按 fluent-ffmpeg 的行为把像素拉到目标尺寸并靠像素宽高比保持显示比例，现在输出总是方形像素。按比例缩放（1280x?、?x720、50%）基于显示比例计算，竖拍视频的旋转元数据会先应用。',
    'videoBitrate / audioBitrate 不带单位时，小于 10000 按 kbps 理解（旧版经 fluent-ffmpeg 自动补 k，videoBitrate=1000 即 1000k），否则按 bit/s；k / M 单位照常。',
    'av1 单独设置 videoBitrate 时按码率上限处理（crf 35 + maxrate），SVT-AV1 的平均码率模式在短视频上偏差很大。',
    'mpeg2video / mpeg1video 只支持标准帧率（23.976、24、25、29.97、30、50、59.94、60），源帧率不标准时自动换成最接近的标准值。',
    'videoCodec=copy / audioCodec=copy 时先按上表检查源编码能否放进目标格式，不能时任务失败并给出原因；表外的编码（ProRes、DTS 等）交给 FFmpeg 尝试。',
    'stripMetadata=true 时去掉全局和流级元数据（标题、创建时间、GPS 等）、章节和 encoder 标签；画面旋转信息不受影响。',
    'flv 里的 mp3 只能是 11025 / 22050 / 44100 Hz，源采样率不符时自动换成 44100。',
  ],
  check: (p) => check(p),

  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await inspectInput(ctx, file);
    const { media } = info;
    const { format } = p;
    // 旧版 format=ogg 对视频输入输出 theora + vorbis 的 Ogg 视频，不能悄悄丢掉画面；纯音频输入仍是 vorbis 音频
    const container = media.video ? videoVariant(format) : format;
    const spec = CONTAINERS[container];
    const audioOnly = isAudioContainer(container);

    if (!media.video && !media.audio) throw new Error('输入文件里没有可用的画面或音轨');
    if (audioOnly && !media.audio)
      throw new Error(`输入文件没有音轨，不能转成纯音频格式 ${format}`);
    const keepVideo = !audioOnly && Boolean(media.video);
    const keepAudio = !p.noAudio && Boolean(media.audio);
    if (!keepVideo && !keepAudio)
      throw new Error('输入文件没有视频画面，设置 noAudio 后没有可输出的内容');

    const videoCopy = p.videoCodec === 'copy';
    const audioCopy = p.audioCodec === 'copy';
    if (keepVideo && videoCopy) {
      const problem = copyProblem('视频', container, info.videoCodec, format);
      if (problem) throw new Error(problem);
    }
    if (keepAudio && audioCopy) {
      const problem = copyProblem('音频', container, info.audioCodec, format);
      if (problem) throw new Error(problem);
    }
    if (keepVideo && p.resolution) {
      const size = expectedSize(p.resolution, {
        width: info.displayWidth,
        height: info.displayHeight,
      });
      const problem = size && sizeProblem(size);
      if (problem) throw new Error(problem);
    }

    const out = ctx.outputPath(format);
    const args = ['-i', file];
    if (keepVideo) args.push('-map', '0:V:0');
    if (keepAudio) args.push('-map', '0:a:0');

    if (keepVideo) {
      const vcodec = resolveVideoCodec(p);
      if (videoCopy || !vcodec) {
        args.push('-c:v', 'copy');
        if (info.videoCodec === 'hevc' && ['mp4', 'm4v', 'mov'].includes(container)) {
          args.push('-tag:v', 'hvc1');
        }
      } else {
        const filters = buildVideoFilters(p, info, vcodec);
        if (filters.length) args.push('-vf', filters.join(','));
        args.push(
          ...videoEncoderArgs({
            codec: vcodec,
            container,
            crf: p.crf,
            preset: p.preset,
            bitrate: p.videoBitrate,
          }),
        );
      }
    }

    if (keepAudio) {
      const acodec = resolveAudioCodec(p);
      if (audioCopy || !acodec) {
        args.push('-c:a', 'copy');
      } else {
        const sourceRate = media.audio?.sampleRate ?? 0;
        const fitted = fitAudioLimits(
          acodec,
          { sampleRate: sourceRate, channels: media.audio?.channels ?? 0 },
          { sampleRate: p.sampleRate, channels: p.channels },
        );
        let { sampleRate } = fitted;
        if (
          format === 'flv' &&
          acodec === 'mp3' &&
          !sampleRate &&
          !FLV_MP3_RATES.includes(sourceRate)
        ) {
          sampleRate = 44100;
        }
        args.push(
          ...audioEncoderArgs({
            codec: acodec,
            bitrate: p.audioBitrate,
            sampleRate,
            channels: fitted.channels,
          }),
        );
      }
    }

    if (p.stripMetadata) {
      // -map_metadata -1 只去掉全局元数据，流级别的要单独关；bitexact 去掉 encoder 标签
      args.push('-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1');
      args.push('-fflags', '+bitexact');
      if (keepVideo && !videoCopy) args.push('-flags:v', '+bitexact');
      if (keepAudio && !audioCopy) args.push('-flags:a', '+bitexact');
    }
    args.push(...muxerArgs(spec), '-y', out);

    ctx.log(`转码为 ${format}${keepVideo ? '' : '（无画面）'}${keepAudio ? '' : '（无音轨）'}`);
    await ctx.ffmpeg(args, { duration: media.duration });
    return { files: [out] };
  },
});
