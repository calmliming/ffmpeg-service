import { z } from 'zod';
import { colorParam, enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AAC_ARGS,
  MAX_GENERATED_SECONDS,
  X264_ARGS,
  num,
  outputSizeParam,
  probeOrThrow,
  probeStreamFacts,
  requireAudio,
} from './common';
import { FIT_DESCRIPTION, fitParam, renderStill } from './image-fit';

const STYLES = [
  'cover',
  'waveform',
  'spectrum',
  'bars',
  'cover-waveform',
  'cover-spectrum',
  'cover-bars',
] as const;
type Style = (typeof STYLES)[number];

const SPECTRUM_COLORS = [
  'channel',
  'intensity',
  'rainbow',
  'moreland',
  'nebulae',
  'fire',
  'fiery',
  'fruit',
  'cool',
  'magma',
  'green',
  'viridis',
  'plasma',
  'cividis',
  'terrain',
] as const;

const params = z.object({
  style: enumParam('style', STYLES).optional().meta({
    description:
      '画面样式。cover：静态封面图；waveform：波形；spectrum：滚动频谱；bars：频谱柱；cover-waveform / cover-spectrum / cover-bars：封面图上叠加对应的可视化。默认有封面图（上传的 image 或音频内嵌封面）时 cover，否则 waveform',
  }),
  size: outputSizeParam('size', 3840, 2160)
    .default({ width: 1280, height: 720 })
    .meta({ description: '输出分辨率，默认 1280x720，最大 3840x2160（奇数自动减 1）' }),
  fps: numberParam('fps', { min: 1, max: 60 })
    .default(25)
    .meta({ description: '帧率（1-60），默认 25' }),
  waveColor: colorParam('waveColor')
    .default('white')
    .meta({ description: '波形 / 频谱柱的颜色，默认 white' }),
  backgroundColor: colorParam('backgroundColor')
    .default('black')
    .meta({ description: '背景色（没有封面图时的底色，以及 fit=contain 的留白），默认 black' }),
  waveMode: enumParam('waveMode', ['cline', 'line', 'p2p', 'point']).default('cline').meta({
    description: '波形画法：cline 居中实心线条、line 竖线、p2p 连线、point 点，默认 cline',
  }),
  spectrumColor: enumParam('spectrumColor', SPECTRUM_COLORS)
    .default('intensity')
    .meta({ description: 'spectrum 样式的配色方案，默认 intensity' }),
  waveHeight: numberParam('waveHeight', { min: 0.1, max: 1 })
    .default(0.3)
    .meta({ description: 'cover-* 样式：可视化条带占画面高度的比例（0.1-1），默认 0.3' }),
  wavePosition: enumParam('wavePosition', ['bottom', 'center', 'top'])
    .default('bottom')
    .meta({ description: 'cover-* 样式：可视化条带的位置，默认 bottom' }),
  fit: fitParam('fit').default('contain').meta({ description: FIT_DESCRIPTION }),
  start: timeParam('start')
    .optional()
    .meta({ description: '从音频的第几秒开始（秒或 HH:MM:SS），默认从头' }),
  duration: timeParam('duration')
    .refine((v) => v > 0, { error: 'duration 必须大于 0' })
    .optional()
    .meta({ description: '只取这么长的一段（秒），默认到音频结束' }),
});

export const fromAudio = defineOperation({
  name: 'video.from-audio',
  route: '/api/video/from-audio',
  title: '音频转视频',
  description:
    '把音频做成视频：静态封面、波形、频谱或频谱柱，也可以在封面图上叠加可视化，常用于把音乐、播客发到视频平台。',
  inputs: [
    { name: 'file', kind: 'media', required: true, description: '音频（也可以是带音轨的视频）' },
    {
      name: 'image',
      kind: 'image',
      required: false,
      description: '封面图；不传时自动使用音频文件内嵌的封面（mp3 / m4a / flac 常见）',
    },
  ],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/from-audio \\',
    '  -F "file=@song.mp3" -F "image=@cover.jpg" \\',
    '  -F "style=cover-waveform" -F "waveColor=#00D4FF" -F "fit=blur"',
    '',
    '# URL 输入，纯波形',
    'curl -X POST http://localhost:9527/api/video/from-audio \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/podcast.m4a","style":"waveform","size":"1080x1080"}\'',
  ].join('\n'),
  notes: [
    '输出时长等于音频时长（或 start / duration 截取的那一段），最长 4 小时。',
    '输出 H.264 + AAC 的 mp4；AAC 音频且不截取时音轨直接流复制。',
    '封面图只解码一次并缩放到输出尺寸，大图不会拖慢编码；动图只取第一帧；图片上限 1 亿像素。',
    'style=cover-* 但没上传 image 时使用音频内嵌封面，两者都没有时任务失败；waveform / spectrum / bars 不使用图片，上传 image 会被拒绝。',
    '分辨率最大 3840x2160，帧率 1-60。',
  ],
  check(p, provided) {
    const hasImage = (provided.image ?? 0) > 0;
    if (p.style && !p.style.startsWith('cover') && hasImage) {
      return `style=${p.style} 不使用图片；要把可视化叠加在图片上请用 style=cover-${p.style}`;
    }
    return undefined;
  },
  async run(ctx, p) {
    const input = ctx.inputs.file[0];
    const image = ctx.inputs.image?.[0];
    const media = await probeOrThrow((f) => ctx.probe(f), input, '音频');
    const audio = requireAudio(media, '输入文件');
    if (!(media.duration > 0)) throw new Error('无法确定音频时长');
    const start = p.start ?? 0;
    if (start >= media.duration) {
      throw new Error(`start（${start} 秒）超出了音频时长（${num(media.duration)} 秒）`);
    }
    const duration = Math.min(p.duration ?? Number.POSITIVE_INFINITY, media.duration - start);
    if (duration > MAX_GENERATED_SECONDS) {
      throw new Error('输出超过 4 小时上限，可以用 start / duration 截取一段');
    }

    let coverStream: string | undefined;
    if (!image && (p.style === undefined || p.style.startsWith('cover'))) {
      const facts = await probeStreamFacts(input, ctx.signal).catch(() => undefined);
      if (facts?.coverStreamIndex !== undefined) coverStream = `0:${facts.coverStreamIndex}`;
    }
    const style: Style = p.style ?? (image || coverStream ? 'cover' : 'waveform');
    const { width: w, height: h } = p.size;
    const fps = num(p.fps);

    // 第一步：封面图适配成输出尺寸
    let still: string | undefined;
    const withCover = style.startsWith('cover');
    if (withCover) {
      if (!image && !coverStream) {
        throw new Error(`style=${style} 需要封面图：请上传 image，或使用带内嵌封面的音频`);
      }
      still = await renderStill(ctx, image ?? input, {
        fit: p.fit,
        size: p.size,
        background: p.backgroundColor,
        name: 'cover.png',
        stream: image ? undefined : coverStream,
        label: image ? '封面图' : '音频内嵌封面',
        range: [0, 0.05],
      });
    }

    // 第二步：可视化叠加到背景上
    const viz = style === 'cover' ? undefined : style.replace(/^cover-/, '');
    const bandHeight = withCover ? Math.max(2, Math.round((h * p.waveHeight) / 2) * 2) : h;
    const bandY =
      !withCover || p.wavePosition === 'top'
        ? 0
        : p.wavePosition === 'center'
          ? Math.round((h - bandHeight) / 2)
          : h - bandHeight;
    const band = `${w}x${bandHeight}`;

    const graph: string[] = [];
    if (still) {
      // 只解码一次：loop 滤镜复用同一帧，不用 -loop 1 每帧重新读图。
      // 先换成微秒时间基，图片输入的时间基（1/25）表示不了其他帧率的帧间隔
      graph.push(
        `[1:v]loop=loop=-1:size=1:start=0,settb=AVTB,setpts=N/(${fps}*TB),fps=${fps},` +
          'format=yuv420p[bg]',
      );
    } else {
      graph.push(`color=c=${p.backgroundColor}:s=${w}x${h}:r=${fps},format=yuv420p[bg]`);
    }
    if (viz === 'waveform') {
      graph.push(
        `[0:a]aformat=channel_layouts=mono,showwaves=s=${band}:mode=${p.waveMode}:rate=${fps}` +
          `:colors=${p.waveColor}:scale=sqrt:draw=full[viz]`,
      );
    } else if (viz === 'bars') {
      graph.push(
        `[0:a]aformat=channel_layouts=mono,showfreqs=s=${band}:mode=bar:ascale=log:fscale=log` +
          `:colors=${p.waveColor}:rate=${fps}[viz]`,
      );
    } else if (viz === 'spectrum') {
      // 频率轴用对数刻度：线性刻度下音乐的能量几乎都挤在画面底部几个像素
      graph.push(
        `[0:a]showspectrum=s=${band}:slide=scroll:mode=combined:color=${p.spectrumColor}` +
          `:scale=log:fscale=log:fps=${fps}:legend=0[viz]`,
      );
    }
    if (viz) {
      graph.push(`[bg][viz]overlay=x=0:y=${bandY}:shortest=1:format=auto,format=yuv420p[outv]`);
    } else {
      graph.push('[bg]null[outv]');
    }

    const args: string[] = [];
    const trimmed = start > 0 || p.duration !== undefined;
    if (start > 0) args.push('-ss', num(start));
    if (p.duration !== undefined) args.push('-t', num(duration));
    args.push('-i', input);
    if (still) args.push('-i', still);
    args.push('-filter_complex', graph.join(';'), '-map', '[outv]', '-map', '0:a:0');
    args.push(...X264_ARGS, '-r', fps);
    // 静态画面用 stillimage 调优，码率更低
    if (!viz) args.push('-tune', 'stillimage');
    args.push(...(audio.codec === 'aac' && !trimmed ? ['-c:a', 'copy'] : AAC_ARGS));
    // 背景是无限循环的画面，靠 -t 在音频结束处收尾
    args.push('-t', num(duration), '-movflags', '+faststart');
    const output = ctx.outputPath('mp4');
    args.push('-y', output);
    await ctx.ffmpeg(args, { duration, range: [still ? 0.05 : 0, 1] });
    return { files: [output] };
  },
});
