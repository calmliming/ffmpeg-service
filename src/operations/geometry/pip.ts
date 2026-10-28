import { z } from 'zod';
import { booleanParam, colorParam, enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AAC_ENCODE,
  audioPassthroughArgs,
  evenFloor,
  evenOffset,
  evenRound,
  fitsMaxSize,
  maxSizeError,
  MP4_OUTPUT,
  num,
  probeVideo,
  requireDuration,
  VIDEO_ENCODE,
  type VideoSource,
} from './common';
import { decodeLoopAudio } from '../compositing/common';

/** 循环的小画面需要先把它的声音解码成 PCM 时，这一步占的进度 */
const LOOP_AUDIO_SHARE = 0.15;

const POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
  'top',
  'bottom',
  'left',
  'right',
] as const;
type Position = (typeof POSITIONS)[number];

const params = z.object({
  position: enumParam('position', POSITIONS).default('bottom-right').meta({
    description:
      '小画面位置：top-left、top-right、bottom-left、bottom-right（默认）、center，或贴边居中的 top、bottom、left、right',
  }),
  width: numberParam('width', { min: 0.05, max: 0.9 })
    .default(0.3)
    .meta({ description: '小画面宽度占主画面宽度的比例 0.05-0.9，默认 0.3，高度按小画面原比例' }),
  margin: numberParam('margin', { min: 0, max: 2000, int: true })
    .default(20)
    .meta({ description: '小画面离主画面边缘的距离（像素），默认 20；center 位置忽略' }),
  startTime: timeParam('startTime').optional().meta({
    description: '小画面出现的时间（秒或 HH:MM:SS），默认从头开始；视频素材从这一刻开始播放',
  }),
  endTime: timeParam('endTime')
    .optional()
    .meta({ description: '小画面消失的时间（秒或 HH:MM:SS），默认一直显示到主视频结束' }),
  audio: enumParam('audio', ['main', 'mix', 'overlay']).default('main').meta({
    description:
      '音频：main（只用主视频的声音，默认）、mix（主视频和小画面的声音混合）、overlay（只用小画面的声音）',
  }),
  border: numberParam('border', { min: 0, max: 100, int: true })
    .default(0)
    .meta({ description: '小画面边框宽度（像素），默认 0 不加边框' }),
  borderColor: colorParam('borderColor')
    .default('white')
    .meta({ description: '边框颜色，默认 white' }),
  opacity: numberParam('opacity', { min: 0.05, max: 1 })
    .default(1)
    .meta({ description: '小画面不透明度 0.05-1，默认 1（完全不透明）' }),
  loopOverlay: booleanParam('loopOverlay').default(false).meta({
    description:
      '小画面视频比主视频短时是否循环播放。默认 false：播完后小画面消失；图片素材始终显示',
  }),
});

type PipParams = z.output<typeof params>;

export interface PipLayout {
  /** 小画面缩放后的尺寸（不含边框） */
  width: number;
  height: number;
  /** 含边框的左上角位置 */
  x: number;
  y: number;
}

/**
 * 计算小画面尺寸和位置：连同边框放不下时等比缩小到主画面以内，位置夹在画面内。
 * 边框宽到连 2 像素的小画面都放不下时抛出中文错误
 */
export function pipLayout(
  main: { width: number; height: number },
  overlay: { width: number; height: number },
  p: Pick<PipParams, 'width' | 'margin' | 'border' | 'position'>,
): PipLayout {
  const b = p.border;
  if (main.width - 2 * b < 2 || main.height - 2 * b < 2) {
    throw new Error(
      `边框 ${b} 像素太宽，主画面 ${main.width}x${main.height} 放不下小画面，请调小 border`,
    );
  }
  const maxWidth = evenFloor(main.width - 2 * b);
  const maxHeight = evenFloor(main.height - 2 * b);
  let width = Math.min(maxWidth, evenRound(main.width * p.width));
  let height = evenRound((overlay.height * width) / overlay.width);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.min(maxWidth, evenRound((overlay.width * height) / overlay.height));
  }
  const boxW = width + 2 * b;
  const boxH = height + 2 * b;
  const m = p.margin;
  const pos: Position = p.position;
  let x = (main.width - boxW) / 2;
  let y = (main.height - boxH) / 2;
  if (pos.includes('left')) x = m;
  if (pos.includes('right')) x = main.width - boxW - m;
  if (pos.startsWith('top')) y = m;
  if (pos.startsWith('bottom')) y = main.height - boxH - m;
  x = Math.min(Math.max(0, x), Math.max(0, main.width - boxW));
  y = Math.min(Math.max(0, y), Math.max(0, main.height - boxH));
  return { width, height, x: evenOffset(x), y: evenOffset(y) };
}

function overlayAudioChain(start: number, end: number | undefined): string {
  const chain = ['asetpts=PTS-STARTPTS'];
  if (start > 0) chain.push(`adelay=delays=${Math.round(start * 1000)}:all=1`);
  if (end !== undefined) chain.push(`atrim=end=${num(end)}`);
  return chain.join(',');
}

export const pip = defineOperation({
  name: 'video.pip',
  route: '/api/video/pip',
  title: '画中画',
  description:
    '把另一个视频或图片缩小后叠加在主视频的角落或中央，可设置出现时间段、边框、透明度和声音来源。',
  inputs: [
    { name: 'file', kind: 'video', required: true, description: '主视频（决定输出的尺寸和时长）' },
    {
      name: 'overlay',
      kind: 'any',
      required: true,
      description: '小画面素材：视频或图片（png / jpg / webp / gif）',
    },
  ],
  params,
  chainable: true,
  example: [
    '# 右下角放一个 30% 宽的小画面，带 4 像素白边',
    'curl -X POST http://localhost:9527/api/video/pip \\',
    '  -F "file=@main.mp4" -F "overlay=@camera.mp4" \\',
    '  -F "position=bottom-right" -F "width=0.3" -F "border=4"',
    '',
    '# 第 5-15 秒在左上角显示一张图片（URL 输入）',
    'curl -X POST http://localhost:9527/api/video/pip \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/main.mp4","overlayUrl":"https://example.com/logo.png","position":"top-left","width":0.2,"startTime":5,"endTime":15}\'',
  ].join('\n'),
  notes: [
    '输出的尺寸、帧率和时长都跟主视频一致；小画面视频更长时会被截断。',
    '小画面视频从 startTime 开始播放；比主视频短时默认播完消失，loopOverlay=true 时循环播放。图片素材在 startTime 到 endTime 之间一直显示，支持 PNG 透明通道。',
    '小画面高度按素材原比例计算；连同边框放不下时自动等比缩小到主画面以内，margin 太大时位置会被夹回画面内；边框宽到放不下小画面时任务失败。',
    '主视频画面最大 7680x4320（竖屏 4320x7680），超出时任务失败。',
    'audio=overlay 要求小画面素材带音轨；audio=mix 时缺音轨的一方会被忽略。小画面的声音同样从 startTime 开始、到 endTime 截止。',
    '画面重新编码为 H.264；audio=main 时 AAC / MP3 音轨直接复制，其他情况转为 AAC。',
  ],
  check(p) {
    if (p.startTime !== undefined && p.endTime !== undefined && p.endTime <= p.startTime) {
      return 'endTime 必须大于 startTime';
    }
    return undefined;
  },
  async run(ctx, p) {
    const main = await probeVideo(ctx, ctx.inputs.file[0], '主视频');
    const duration = requireDuration(main, '主视频');
    if (!fitsMaxSize(main.width, main.height)) {
      throw new Error(maxSizeError('主视频画面', main.width, main.height));
    }
    const overlay: VideoSource = await probeVideo(ctx, ctx.inputs.overlay[0], '画中画素材').catch(
      (err: Error) => {
        if (ctx.signal.aborted) throw err;
        throw new Error(`${err.message}（overlay 需要视频或图片）`);
      },
    );
    const start = p.startTime ?? 0;
    if (start >= duration) {
      throw new Error(`startTime ${start} 秒超出了主视频时长 ${duration.toFixed(2)} 秒`);
    }
    const layout = pipLayout(main, overlay, p);
    const still = overlay.isStill;
    ctx.log(
      `画中画：主画面 ${main.width}x${main.height}，小画面 ${layout.width}x${layout.height} @ (${layout.x}, ${layout.y})，${still ? '图片' : '视频'}`,
    );

    // 小画面：缩放 → 边框 → 透明度 → 平移到 startTime。需要边框或透明度时转 rgba，边框位置不受色度对齐影响
    const ovChain = ['setpts=PTS-STARTPTS', ...overlay.prefilters];
    ovChain.push(`scale=${layout.width}:${layout.height}`, 'setsar=1');
    if (p.border > 0 || p.opacity < 1) ovChain.push('format=rgba');
    if (p.border > 0) {
      const b = p.border;
      ovChain.push(
        `pad=${layout.width + 2 * b}:${layout.height + 2 * b}:${b}:${b}:color=${p.borderColor}`,
      );
    }
    if (p.opacity < 1) ovChain.push(`colorchannelmixer=aa=${num(p.opacity)}`);
    if (start > 0) ovChain.push(`setpts=PTS+${num(start)}/TB`);

    // 图片只有一帧，靠 eof_action=repeat 一直显示；视频播完用 pass 让小画面消失
    const overlayOpts = [
      `x=${layout.x}`,
      `y=${layout.y}`,
      `eof_action=${still ? 'repeat' : 'pass'}`,
    ];
    if (p.endTime !== undefined) {
      overlayOpts.push(`enable='between(t,${num(start)},${num(p.endTime)})'`);
    }
    // 主画面不改时间戳，否则复制过来的主音轨会和画面错开片头的那点偏移
    const graph = [
      `[0:V:0]${[...main.prefilters, 'null'].join(',')}[main]`,
      `[1:V:0]${ovChain.join(',')}[ov]`,
      `[main][ov]overlay=${overlayOpts.join(':')},format=yuv420p[v]`,
    ];

    // 声音来源
    const mainAudio = Boolean(main.media.audio);
    const ovAudio = Boolean(overlay.media.audio) && !still;
    if (p.audio === 'overlay' && !ovAudio) {
      throw new Error('audio=overlay 需要画中画素材带音轨，当前素材没有音频');
    }
    let audioArgs: string[] = [];
    const useMain = p.audio === 'main' || (p.audio === 'mix' && !ovAudio);
    const useOverlay = p.audio === 'overlay' || (p.audio === 'mix' && !mainAudio);
    // 循环播放的小画面要用它的声音时，压缩音频直接 -stream_loop 每个接缝有几十毫秒空洞、越循环越偏，
    // 先解码成 PCM 再单独循环（见 decodeLoopAudio）
    let loopAudio: string | undefined;
    if (p.loopOverlay && !still && !useMain && ovAudio) {
      const audioLength = overlay.media.audio?.duration || overlay.media.duration;
      loopAudio = await decodeLoopAudio(ctx, overlay.file, audioLength, [0, LOOP_AUDIO_SHARE]);
    }
    const ovA = loopAudio ? '2:a:0' : '1:a:0';
    if (useMain) {
      if (mainAudio) audioArgs = ['-map', '0:a:0', ...audioPassthroughArgs(main.media)];
      else if (p.audio === 'mix') ctx.log('主视频和画中画素材都没有音轨，输出无声音');
    } else if (useOverlay) {
      if (p.audio === 'mix') ctx.log('主视频没有音轨，只使用画中画素材的声音');
      graph.push(`[${ovA}]${overlayAudioChain(start, p.endTime)}[aout]`);
      audioArgs = ['-map', '[aout]', ...AAC_ENCODE];
    } else {
      // 先统一采样率和声道，两路格式不同时 amix 才能稳定协商；
      // amix 默认 normalize 会把两路都减半，关掉后用 alimiter 防削波（和 compose 一致）
      const unify = 'aformat=sample_rates=48000:channel_layouts=stereo';
      graph.push(
        `[0:a:0]${unify}[mainA]`,
        `[${ovA}]${overlayAudioChain(start, p.endTime)},${unify}[ova]`,
        '[mainA][ova]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=0:latency=1[aout]',
      );
      audioArgs = ['-map', '[aout]', ...AAC_ENCODE];
    }

    const inputArgs = ['-i', main.file];
    if (p.loopOverlay && !still) inputArgs.push('-stream_loop', '-1');
    inputArgs.push('-i', overlay.file);
    if (loopAudio) inputArgs.push('-stream_loop', '-1', '-i', loopAudio);
    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(
      [
        ...inputArgs,
        '-filter_complex',
        graph.join(';'),
        '-map',
        '[v]',
        ...audioArgs,
        ...VIDEO_ENCODE,
        // 小画面循环时是无限输入，overlay 也会在主画面结束后继续出帧，按主视频时长截断
        '-t',
        num(duration),
        ...MP4_OUTPUT,
        '-y',
        output,
      ],
      loopAudio ? { duration, range: [LOOP_AUDIO_SHARE, 1] } : { duration },
    );
    return {
      files: [output],
      data: { ...layout, overlayType: still ? 'image' : 'video' },
    };
  },
});
