import { z } from 'zod';
import { booleanParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { VIDEO_INPUT, assertFrameSize, filterChainArgs, inspectVideo, num } from './shared';

// hqdn3d 的默认值 4:3:6:4.5 作为 medium，light 减半、strong 翻倍
const DENOISE = {
  light: 'hqdn3d=luma_spatial=2:chroma_spatial=1.5:luma_tmp=3:chroma_tmp=2.25',
  medium: 'hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4.5',
  strong: 'hqdn3d=luma_spatial=8:chroma_spatial=6:luma_tmp=12:chroma_tmp=9',
} as const;

const params = z.object({
  denoise: enumParam('denoise', ['none', 'light', 'medium', 'strong'] as const)
    .default('none')
    .meta({ description: '降噪强度（hqdn3d）：none（默认）、light、medium、strong' }),
  sharpen: numberParam('sharpen', { min: 0, max: 2 })
    .default(0)
    .meta({ description: '锐化强度 0-2（unsharp，只锐化亮度），0 为不锐化，常用 0.5-1' }),
  deinterlace: booleanParam('deinterlace')
    .default(false)
    .meta({ description: '去隔行（bwdif），用于电视录制、老摄像机等隔行扫描素材，默认 false' }),
  deband: booleanParam('deband')
    .default(false)
    .meta({ description: '去色带：消除天空、渐变背景上压缩造成的条纹，默认 false' }),
});

type EnhanceParams = z.output<typeof params>;

/** 顺序有讲究：去隔行必须最先，锐化放最后，否则会把噪点和色带一起锐化 */
export function enhanceFilters(p: EnhanceParams): string[] {
  const filters: string[] = [];
  if (p.deinterlace) filters.push('bwdif=mode=send_frame:parity=auto:deint=all');
  if (p.denoise !== 'none') filters.push(DENOISE[p.denoise]);
  if (p.deband) filters.push('deband');
  if (p.sharpen > 0) {
    filters.push(
      `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${num(p.sharpen)}:chroma_msize_x=5:chroma_msize_y=5:chroma_amount=0`,
    );
  }
  return filters;
}

export const enhance = defineOperation({
  name: 'video.enhance',
  route: '/api/video/enhance',
  title: '画质增强',
  description: '对视频做降噪、锐化、去隔行和去色带处理，改善手机夜景、老录像等素材的观感。',
  inputs: VIDEO_INPUT,
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/enhance \\',
    '  -F "file=@input.mp4" \\',
    '  -F "denoise=medium" -F "sharpen=0.8"',
  ].join('\n'),
  notes: [
    '至少要开启一项：denoise 不为 none、sharpen 大于 0、deinterlace 或 deband。',
    '处理顺序固定为：去隔行 → 降噪 → 去色带 → 锐化。',
    'deinterlace 每帧输出一帧（帧率不变），对逐行素材使用会让画面略微变软。',
    '画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。',
  ],
  check(p) {
    if (enhanceFilters(p).length === 0) {
      return '至少需要开启一项：denoise、sharpen、deinterlace 或 deband';
    }
    return undefined;
  },
  async run(ctx, p) {
    const input = await inspectVideo(ctx, ctx.inputs.file[0]);
    assertFrameSize(input);
    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(filterChainArgs(input, enhanceFilters(p), output), {
      duration: input.duration,
    });
    return { files: [output] };
  },
});
