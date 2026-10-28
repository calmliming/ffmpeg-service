import { z } from 'zod';
import { booleanParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AUDIO_ENCODE,
  FASTSTART,
  VIDEO_ENCODE,
  atempoChain,
  evenSizeFilters,
  fmtSec,
  num,
  outputFps,
  probeInput,
  reencodeExt,
} from './shared';

/** 变速后的输出时长上限：0.25 倍慢放会让时长变成 4 倍 */
const MAX_OUTPUT_SECONDS = 4 * 3600;
/** 运动补偿插帧非常慢，只对 1080p 及以下开放 */
const MAX_MOTION_PIXELS = 1920 * 1088;

export const speedOperation = defineOperation({
  name: 'video.speed',
  route: '/api/video/speed',
  title: '视频变速',
  description:
    '把视频或音频加速 / 减速（0.25-4 倍）。默认声音保持原音调，也可以像磁带快放一样连音调一起变；慢放时可选补帧让画面更顺滑。',
  inputs: [{ name: 'file', kind: 'media', required: true, description: '视频或音频文件' }],
  params: z.object({
    factor: numberParam('factor', { min: 0.25, max: 4 }).meta({
      description: '速度倍数，0.25-4。2 表示两倍速（时长减半），0.5 表示慢放一半速度',
    }),
    keepPitch: booleanParam('keepPitch').default(true).meta({
      description:
        '是否保持音调。true（默认）用 atempo 变速不变调；false 连音调一起变（快放变尖、慢放变低沉）',
    }),
    fps: numberParam('fps', { min: 1, max: 120 }).optional().meta({
      description: '输出帧率，1-120。默认沿用原视频帧率（超过 120 时取 120）',
    }),
    interpolation: enumParam('interpolation', ['none', 'blend', 'motion']).default('none').meta({
      description:
        '慢放补帧方式：none（默认，重复帧）、blend（相邻帧混合，较快）、motion（运动补偿插帧，最顺滑但很慢，仅支持 1080p 及以下）',
    }),
    mute: booleanParam('mute').default(false).meta({
      description: '是否去掉声音，默认 false',
    }),
  }),
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/speed \\',
    '  -F "file=@video.mp4" \\',
    '  -F "factor=2"',
    '',
    '# 慢放 0.5 倍并用运动补偿补帧（URL 输入）',
    'curl -X POST http://localhost:9527/api/video/speed \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","factor":0.5,"interpolation":"motion"}\'',
  ].join('\n'),
  notes: [
    '画面用 setpts 变速，声音用 atempo 变速；atempo 单级只支持 0.5-2 倍，超出时自动拆成多级串联，音质不受影响。',
    '默认输出帧率与原视频相同：加速时丢帧、慢放时重复帧。需要顺滑慢动作时用 interpolation=blend 或 motion。',
    'interpolation=motion 使用 minterpolate 运动补偿，速度只有实时的几分之一，只允许 1080p 及以下的视频。',
    '纯音频文件也可以变速，输出 m4a（AAC）；没有音轨的视频只处理画面。',
    `输出时长上限 ${MAX_OUTPUT_SECONDS / 3600} 小时（原时长 ÷ factor）。`,
  ],
  async run(ctx, params) {
    const input = ctx.inputs.file[0];
    const media = await probeInput(ctx, input);
    const { factor } = params;
    const duration = media.duration / factor;
    if (duration > MAX_OUTPUT_SECONDS) {
      throw new Error(
        `变速后时长 ${fmtSec(duration)} 秒超过上限 ${MAX_OUTPUT_SECONDS / 3600} 小时，请提高 factor 或先裁剪`,
      );
    }
    if (!media.video && params.mute)
      throw new Error('纯音频文件不能设置 mute=true，否则没有任何输出');

    const args = ['-i', input];
    let fps: number | undefined;
    if (media.video) {
      const v = media.video;
      fps = params.fps ?? outputFps(media);
      const filters = [`setpts=PTS/${num(factor)}`];
      if (params.interpolation === 'motion') {
        if (v.width * v.height > MAX_MOTION_PIXELS) {
          throw new Error(
            `interpolation=motion 只支持 1080p 及以下的视频，当前为 ${v.width}x${v.height}，请改用 blend`,
          );
        }
        filters.push(
          `minterpolate=fps=${num(fps)}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
        );
      } else if (params.interpolation === 'blend') {
        filters.push(`framerate=fps=${num(fps)}`);
      } else {
        // 不固定帧率时 4 倍速会产生 4 倍帧率的时间戳，播放器和编码器都吃不消
        filters.push(`fps=${num(fps)}`);
      }
      filters.push(...evenSizeFilters(media));
      args.push('-map', '0:V:0', '-vf', filters.join(','), ...VIDEO_ENCODE);
    }
    if (media.audio && !params.mute) {
      // 变调模式先统一重采样到 48 kHz，asetrate 才有确定的基准，不依赖探测到的采样率
      const filters = params.keepPitch
        ? atempoChain(factor)
        : ['aresample=48000', `asetrate=${Math.round(48000 * factor)}`, 'aresample=48000'];
      args.push('-map', '0:a:0', '-af', filters.join(','), ...AUDIO_ENCODE);
    }
    const ext = reencodeExt(media);
    const output = ctx.outputPath(ext);
    args.push(...FASTSTART, '-y', output);

    ctx.progress(0, { phase: 'processing' });
    await ctx.ffmpeg(args, { duration });
    return {
      files: [output],
      data: { factor, duration: Number(duration.toFixed(3)), fps },
    };
  },
});
