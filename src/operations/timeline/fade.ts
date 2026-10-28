import { z } from 'zod';
import { booleanParam, colorParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AUDIO_ENCODE,
  FASTSTART,
  VIDEO_ENCODE,
  audioStreamDuration,
  copyAudioArgs,
  copyVideoArgs,
  evenSizeFilters,
  fmtSec,
  num,
  probeInput,
  reencodeExt,
  sec,
} from './shared';

const MAX_FADE = 60;
// afade 的曲线，取常用的几种
const CURVES = [
  'tri',
  'qsin',
  'hsin',
  'esin',
  'log',
  'ipar',
  'qua',
  'cub',
  'squ',
  'cbr',
  'par',
  'exp',
] as const;

function fadeSeconds(name: string, description: string) {
  return numberParam(name, { min: 0, max: MAX_FADE }).optional().meta({ description });
}

export const fadeOperation = defineOperation({
  name: 'video.fade',
  route: '/api/video/fade',
  title: '淡入淡出',
  description:
    '给视频开头加淡入、结尾加淡出（从黑场 / 白场或任意颜色渐变），声音同步淡入淡出。纯音频文件只处理声音。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '视频或音频文件' }],
  params: z.object({
    fadeIn: fadeSeconds('fadeIn', `开头淡入的秒数，0-${MAX_FADE}，默认 0（不淡入）`),
    fadeOut: fadeSeconds('fadeOut', `结尾淡出的秒数，0-${MAX_FADE}，默认 0（不淡出）`),
    color: colorParam('color').default('black').meta({
      description: '淡入淡出的底色：black（默认）、white，或任意颜色名 / #RRGGBB',
    }),
    audio: booleanParam('audio').default(true).meta({
      description: '声音是否同步淡入淡出，默认 true；false 时声音原样保留',
    }),
    audioFadeIn: fadeSeconds('audioFadeIn', '声音淡入秒数，默认与 fadeIn 相同'),
    audioFadeOut: fadeSeconds('audioFadeOut', '声音淡出秒数，默认与 fadeOut 相同'),
    curve: enumParam('curve', CURVES).default('tri').meta({
      description:
        '声音淡入淡出曲线：tri（默认，线性）、qsin、hsin、esin、log、ipar、qua、cub、squ、cbr、par、exp',
    }),
  }),
  chainable: true,
  check(params) {
    const values = [params.fadeIn, params.fadeOut, params.audioFadeIn, params.audioFadeOut];
    if (!values.some((value) => (value ?? 0) > 0)) {
      return 'fadeIn 和 fadeOut 至少要有一个大于 0';
    }
    return undefined;
  },
  example: [
    'curl -X POST http://localhost:9527/api/video/fade \\',
    '  -F "file=@video.mp4" \\',
    '  -F "fadeIn=1" \\',
    '  -F "fadeOut=2" \\',
    '  -F "color=white"',
  ].join('\n'),
  notes: [
    `每段淡入 / 淡出最长 ${MAX_FADE} 秒，且淡入 + 淡出不能超过素材时长。`,
    '淡出按画面流和音轨各自的实际时长计算，音画长度不一致的素材也会在各自结尾淡到底。',
    '只淡画面时声音直接流复制；只淡声音（fadeIn / fadeOut 为 0、只给 audioFadeIn / audioFadeOut）时画面直接流复制。',
    '纯音频文件输出 m4a（AAC），此时 audio 必须为 true。',
  ],
  async run(ctx, params) {
    const input = ctx.inputs.file[0];
    const media = await probeInput(ctx, input);
    const vIn = params.fadeIn ?? 0;
    const vOut = params.fadeOut ?? 0;
    const aIn = params.audio ? (params.audioFadeIn ?? vIn) : 0;
    const aOut = params.audio ? (params.audioFadeOut ?? vOut) : 0;
    if (!media.video && aIn === 0 && aOut === 0) {
      throw new Error('纯音频文件只能淡入淡出声音，请设置 audio=true 并给出 fadeIn / fadeOut');
    }

    const args = ['-i', input];
    if (media.video) {
      const vDur = media.video.duration || media.duration;
      if (vIn + vOut > vDur + 1e-3) {
        throw new Error(
          `淡入 ${fmtSec(vIn)} 秒 + 淡出 ${fmtSec(vOut)} 秒超过了视频时长 ${fmtSec(vDur)} 秒`,
        );
      }
      args.push('-map', '0:V:0');
      if (vIn > 0 || vOut > 0) {
        const filters: string[] = [];
        if (vIn > 0) filters.push(`fade=t=in:st=0:d=${sec(vIn)}:color=${params.color}`);
        if (vOut > 0) {
          const start = Math.max(0, vDur - vOut);
          filters.push(`fade=t=out:st=${sec(start)}:d=${sec(vOut)}:color=${params.color}`);
        }
        filters.push(...evenSizeFilters(media));
        args.push('-vf', filters.join(','), ...VIDEO_ENCODE);
      } else {
        args.push(...copyVideoArgs(media));
      }
    }
    if (media.audio) {
      args.push('-map', '0:a:0');
      if (aIn > 0 || aOut > 0) {
        const aDur = await audioStreamDuration(ctx, input, media);
        if (aIn + aOut > aDur + 1e-3) {
          throw new Error(
            `声音淡入 ${fmtSec(aIn)} 秒 + 淡出 ${fmtSec(aOut)} 秒超过了音轨时长 ${fmtSec(aDur)} 秒`,
          );
        }
        const filters: string[] = [];
        if (aIn > 0) filters.push(`afade=t=in:st=0:d=${sec(aIn)}:curve=${params.curve}`);
        if (aOut > 0) {
          const start = Math.max(0, aDur - aOut);
          filters.push(`afade=t=out:st=${num(start)}:d=${sec(aOut)}:curve=${params.curve}`);
        }
        args.push('-af', filters.join(','), ...AUDIO_ENCODE);
      } else {
        args.push(...copyAudioArgs(media));
      }
    }
    const output = ctx.outputPath(reencodeExt(media));
    args.push(...FASTSTART, '-y', output);

    ctx.progress(0, { phase: 'processing' });
    await ctx.ffmpeg(args, { duration: media.duration });
    return { files: [output] };
  },
});
