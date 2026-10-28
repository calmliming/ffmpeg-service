import { z } from 'zod';
import { defineOperation } from '../types';
import {
  blankToUndefined,
  booleanParam,
  numberParam,
  parseTime,
  timeParam,
} from '../../schemas/coerce';
import { CONTAINERS, isAudioCodec, isVideoCodec, type AudioCodec, type Container } from './formats';
import {
  audioEncoderArgs,
  crfProblem,
  isMpegVideo,
  matchSourceBitrate,
  muxerArgs,
  nearestMpegFps,
  parseFrameRate,
  presetParam,
  supportsPreset,
  videoEncoderArgs,
} from './encode';
import {
  codecsFit,
  inspectInput,
  keyframeSafeSeek,
  sourceContainer,
  type InputInfo,
} from './probe';

const START_FORMAT = 'startTime 必须是秒数或 HH:MM:SS 格式的时间';

// 与 timeParam 相同，只是没传时提示「缺参数」而不是「格式不对」（旧版的报错就是请提供 startTime 参数）
const startTimeParam = z.preprocess(
  (value) => {
    const v = blankToUndefined(value);
    return v === undefined ? undefined : (parseTime(v) ?? Number.NaN);
  },
  z
    .number({
      error: (issue) =>
        issue.input === undefined ? '请提供 startTime 参数（秒数或 HH:MM:SS）' : START_FORMAT,
    })
    .min(0, { error: START_FORMAT }),
);

const params = z.object({
  startTime: startTimeParam.meta({
    description: '起始时间：秒数（5、12.5）或 HH:MM:SS[.mmm]（00:00:05）',
  }),
  endTime: timeParam('endTime').optional().meta({
    description:
      '结束时间（绝对时间点），格式同 startTime，必须大于 startTime；同时给了 duration 时以 endTime 为准',
  }),
  duration: timeParam('duration')
    .optional()
    .meta({ description: '截取时长：秒数或 HH:MM:SS。endTime 和 duration 都不给时截到结尾' }),
  accurate: booleanParam('accurate').default(true).meta({
    description:
      'true（默认）重新编码，精确到帧；false 直接复制流，速度很快且无损，但起点会落在前一个关键帧上',
  }),
  crf: numberParam('crf', { min: 0, max: 63, int: true }).optional().meta({
    description: 'accurate=true 时的画质（h264 / h265 为 0-51，vp9 / av1 为 0-63），默认 h264 23',
  }),
  preset: presetParam('preset')
    .optional()
    .meta({ description: 'accurate=true 时的编码速度，ultrafast … veryslow，默认 veryfast' }),
});

const AUDIO_CONTAINER_FOR: Partial<Record<AudioCodec, Container>> = {
  mp3: 'mp3',
  aac: 'm4a',
  alac: 'm4a',
  opus: 'opus',
  vorbis: 'ogg',
  flac: 'flac',
  pcm_s16le: 'wav',
  pcm_s24le: 'wav',
};

/** 认识的编码都在容器允许列表里；不认识的编码（ProRes、DTS…）原容器本来就装得下，按可以处理 */
function knownCodecsFit(container: Container, info: InputInfo): boolean {
  const spec = CONTAINERS[container];
  const { videoCodec, audioCodec } = info;
  if (info.media.video && isVideoCodec(videoCodec) && !spec.video?.includes(videoCodec))
    return false;
  if (isAudioCodec(audioCodec) && !spec.audio.includes(audioCodec)) return false;
  return true;
}

/** 输出容器尽量与输入一致；输入格式不在白名单时，重新编码输出 mp4 / m4a，流复制按编码挑能装下的容器 */
export function chooseTrimContainer(info: InputInfo, copy: boolean): Container {
  const source = sourceContainer(info);
  if (source && (!copy || knownCodecsFit(source, info))) return source;
  const hasVideo = Boolean(info.media.video);
  if (!copy) return hasVideo ? 'mp4' : 'm4a';
  if (!hasVideo) {
    const codec = info.audioCodec;
    return (isAudioCodec(codec) && AUDIO_CONTAINER_FOR[codec]) || 'mkv';
  }
  return codecsFit('mp4', info) ? 'mp4' : 'mkv';
}

const seconds = (n: number) => String(Math.round(n * 1000) / 1000);

export const trim = defineOperation({
  name: 'trim',
  route: '/api/edit/trim',
  title: '裁剪片段',
  description:
    '按时间截取音视频的一段。默认重新编码、精确到帧；accurate=false 时直接复制流，速度快但起点对齐关键帧。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '要裁剪的视频或音频文件' }],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/edit/trim \\',
    '  -F "file=@video.mp4" -F "startTime=00:00:05" -F "duration=10"',
    '',
    '# 用 URL 提交，快速裁剪（不重新编码）',
    'curl -X POST http://localhost:9527/api/edit/trim -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","startTime":"1:30","endTime":"2:00","accurate":false}\'',
  ].join('\n'),
  notes: [
    '时间格式：秒数（5、12.5）或 [[HH:]MM:]SS[.mmm]（00:00:05、1:30、0:00:01.500）。',
    'endTime 是绝对时间点、duration 是长度；两者都给时以 endTime 为准（与旧版一致），都不给时截到结尾。endTime 超过媒体时长时截到结尾；startTime 不小于媒体时长时任务失败。',
    'accurate=true（默认）重新编码：沿用源编码（h264 → h264、hevc → h265、vp9 → vp9…，源编码不在支持列表时换成该容器的默认编码），音频码率沿用源码率。accurate=false 用流复制：几乎瞬间完成且无损，但起点落在前一个关键帧，MP4 输出靠 edit list 从指定时间开始播放，其它容器可能多出开头的几帧到几秒。FLAC 音频在流复制时也重新编码（无损），否则文件头里的总时长仍是原文件的。',
    '输出格式与输入相同（按 ffprobe 识别，不看扩展名）。输入是其它格式（如 wmv / asf、mxf）时：重新编码输出 mp4（纯音频输出 m4a）；流复制按编码挑能装下的容器（mp4，装不下时 mkv；纯音频按编码选 mp3 / m4a / ogg / opus / flac / wav）。',
    '只保留第一路画面和第一路音轨。',
    'MPEG-TS / MPEG-PS（.ts、.mts、.m2ts、.mpg、.vob）没有关键帧索引，直接跳转会落在关键帧之后：先找起点之前的关键帧再从那里解码，结果同样精确到帧；找不到可用的关键帧时从头解码（长文件会慢一些，流复制则沿用直接跳转）。起点在画面范围内、但截取结果没有画面时任务失败，不会只返回声音。',
  ],
  check(p) {
    if (p.endTime !== undefined && p.endTime <= p.startTime) return 'endTime 必须大于 startTime';
    if (p.endTime === undefined && p.duration !== undefined && p.duration <= 0) {
      return 'duration 必须大于 0';
    }
    if (!p.accurate) {
      const conflicts = [p.crf !== undefined && 'crf', p.preset && 'preset'].filter(Boolean);
      if (conflicts.length) {
        return `accurate=false 直接复制流、不重新编码，不能设置 ${conflicts.join('、')}`;
      }
    }
    return undefined;
  },

  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const info = await inspectInput(ctx, file);
    const { media } = info;
    if (!media.video && !media.audio) throw new Error('输入文件里没有可用的画面或音轨');

    const start = p.startTime;
    const total = media.duration;
    if (total > 0 && start >= total) {
      throw new Error(`startTime（${seconds(start)} 秒）超出了媒体时长（${seconds(total)} 秒）`);
    }
    const requested = p.endTime !== undefined ? p.endTime - start : p.duration;
    const length = total > 0 ? Math.min(requested ?? Infinity, total - start) : requested;

    const copy = !p.accurate;
    const container = chooseTrimContainer(info, copy);
    const spec = CONTAINERS[container];
    const keepVideo = Boolean(media.video && spec.video);
    const keepAudio = Boolean(media.audio);

    // -ss 放在 -i 前面是输入端跳转：直接定位到附近的关键帧，重新编码时再丢掉多余的帧，既快又精确到帧。
    // MPEG-TS / PS 没有关键帧索引，输入端跳转会落在关键帧之后（开头缺画面甚至整段没画面）：
    // 先跳到起点之前的关键帧，重新编码时用 -i 之后的 -ss 在解码端丢掉多出的部分；流复制本来就从关键帧开始，多出的部分计入 -t
    const safe = await keyframeSafeSeek(ctx, file, info, start);
    const from = safe ?? (copy ? start : 0);
    const skip = Math.max(0, start - from);
    const args: string[] = [];
    if (from > 0) args.push('-ss', seconds(from));
    args.push('-i', file);
    if (!copy && skip > 0) args.push('-ss', seconds(skip));
    if (requested !== undefined) args.push('-t', seconds(copy ? skip + requested : requested));
    if (keepVideo) args.push('-map', '0:V:0');
    if (keepAudio) args.push('-map', '0:a:0');

    if (copy) {
      args.push('-c', 'copy');
      // 复制 FLAC 时 STREAMINFO 里的总采样数沿用整个源文件，截出 1 秒播放器也显示原时长；
      // FLAC 本身无损，重新编码不损失音质，还能写对时长
      if (keepAudio && info.audioCodec === 'flac') args.push('-c:a', 'flac');
      if (keepVideo && info.videoCodec === 'hevc' && ['mp4', 'm4v', 'mov'].includes(container)) {
        args.push('-tag:v', 'hvc1');
      }
    } else {
      if (keepVideo && spec.video) {
        const source = info.videoCodec;
        const codec =
          isVideoCodec(source) && spec.video.includes(source) ? source : spec.defaultVideo;
        if (!codec) throw new Error(`${container} 没有可用的视频编码`);
        const problem =
          (p.crf !== undefined ? crfProblem(codec, p.crf) : undefined) ??
          (p.preset && !supportsPreset(codec) ? `${codec} 编码不支持 preset` : undefined);
        if (problem) throw new Error(`${problem}（输出沿用源视频编码 ${codec}）`);

        const filters: string[] = [];
        const v = media.video;
        if (isMpegVideo(codec)) {
          const fps = nearestMpegFps(
            parseFrameRate(v?.avgFrameRate) || parseFrameRate(v?.frameRate),
          );
          if (fps) filters.push(`fps=${fps}`);
        }
        if (v && (v.width % 2 || v.height % 2)) filters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');
        if (filters.length) args.push('-vf', filters.join(','));
        args.push(...videoEncoderArgs({ codec, container, crf: p.crf, preset: p.preset }));
      }
      if (keepAudio) {
        const source = info.audioCodec;
        const codec =
          isAudioCodec(source) && spec.audio.includes(source) ? source : spec.defaultAudio;
        const bitrate = matchSourceBitrate(codec, info.audioBitrate);
        args.push(...audioEncoderArgs({ codec, bitrate }));
      }
    }
    const out = ctx.outputPath(container);
    args.push(...muxerArgs(spec), '-y', out);

    ctx.log(
      `裁剪 ${seconds(start)}s 起 ${length !== undefined ? `${seconds(length)}s` : '到结尾'}，${copy ? '流复制' : '重新编码'}，输出 ${container}` +
        (skip > 0 ? `（从 ${seconds(from)}s 的关键帧前开始读取）` : ''),
    );
    await ctx.ffmpeg(args, { duration: length });

    // ffmpeg 解不出画面时（源文件损坏、跳转落在关键帧之后）照样以 0 退出，只写出音轨；起点离画面结尾还远时必须有画面
    const videoEnd = media.video?.duration || total;
    if (keepVideo && start < videoEnd - 0.5) {
      const result = await ctx.probe(out);
      if (!result.video || !(result.video.width > 0)) {
        throw new Error(
          `截取结果没有画面：源文件在 ${seconds(start)} 秒附近的画面无法解码，请换一个起点或检查源文件`,
        );
      }
    }
    return { files: [out] };
  },
});
