import fs from 'fs';
import { z } from 'zod';
import { booleanParam, colorParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation, type OperationContext } from '../types';
import {
  AAC_ARGS,
  MAX_GENERATED_SECONDS,
  X264_ARGS,
  decodeLoopAudio,
  mapLimit,
  num,
  outputSizeParam,
  probeOrThrow,
  requireAudio,
  type OutputSize,
} from './common';
import { FIT_DESCRIPTION, checkImage, fitParam, renderStill, type FitMode } from './image-fit';

// FFmpeg 8.1 的全部 xfade 转场（custom 需要表达式，不开放）
export const XFADE_TRANSITIONS = [
  'fade',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circlecrop',
  'rectcrop',
  'distance',
  'fadeblack',
  'fadewhite',
  'radial',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'circleopen',
  'circleclose',
  'vertopen',
  'vertclose',
  'horzopen',
  'horzclose',
  'dissolve',
  'pixelize',
  'diagtl',
  'diagtr',
  'diagbl',
  'diagbr',
  'hlslice',
  'hrslice',
  'vuslice',
  'vdslice',
  'hblur',
  'fadegrays',
  'wipetl',
  'wipetr',
  'wipebl',
  'wipebr',
  'squeezeh',
  'squeezev',
  'zoomin',
  'fadefast',
  'fadeslow',
  'hlwind',
  'hrwind',
  'vuwind',
  'vdwind',
  'coverleft',
  'coverright',
  'coverup',
  'coverdown',
  'revealleft',
  'revealright',
  'revealup',
  'revealdown',
] as const;

const TRANSITIONS = ['none', 'random', ...XFADE_TRANSITIONS] as const;

// random 只在观感柔和的转场里挑
const RANDOM_POOL = [
  'fade',
  'dissolve',
  'fadeblack',
  'wipeleft',
  'wiperight',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'circleopen',
  'circleclose',
  'radial',
  'zoomin',
  'coverleft',
  'coverright',
  'revealleft',
  'revealright',
  'horzopen',
  'vertopen',
];

/** 每段最多几张图。一条命令的输入越多 FFmpeg 越吃内存（实测 100 张 720p 图约 1.3 GB），分段渲染后流复制拼接 */
const CHUNK_IMAGES = 10;
/** Ken Burns 的缩放幅度 */
const KEN_BURNS_ZOOM = 0.12;
const MIN_IMAGE_SECONDS = 0.5;

const params = z.object({
  durationPerImage: numberParam('durationPerImage', { min: MIN_IMAGE_SECONDS, max: 60 })
    .default(3)
    .meta({ description: '每张图显示的秒数（0.5-60，含转场），默认 3；fitToAudio=true 时忽略' }),
  transition: enumParam('transition', TRANSITIONS).default('fade').meta({
    description:
      '转场效果：none 无转场、random 每次随机，或任一 FFmpeg xfade 转场名（fade、dissolve、wipeleft、slideleft、circleopen、zoomin、fadeblack、pixelize 等），默认 fade',
  }),
  transitionDuration: numberParam('transitionDuration', { min: 0.2, max: 3 })
    .default(0.5)
    .meta({ description: '转场时长（0.2-3 秒），默认 0.5；不能超过每张图时长的一半' }),
  size: outputSizeParam('size', 3840, 2160)
    .default({ width: 1280, height: 720 })
    .meta({ description: '输出分辨率，默认 1280x720，最大 3840x2160（奇数自动减 1）' }),
  fit: fitParam('fit').default('contain').meta({ description: FIT_DESCRIPTION }),
  backgroundColor: colorParam('backgroundColor')
    .default('black')
    .meta({ description: 'fit=contain 时的留白颜色，以及透明图片的底色，默认 black' }),
  kenBurns: booleanParam('kenBurns')
    .default(false)
    .meta({ description: '开启 Ken Burns 效果：每张图缓慢推近、拉远或平移（幅度 12%）' }),
  fps: numberParam('fps', { min: 1, max: 60 })
    .default(25)
    .meta({ description: '帧率（1-60），默认 25' }),
  fitToAudio: booleanParam('fitToAudio')
    .default(false)
    .meta({ description: '按音频时长平均分配每张图的显示时间，视频与音频等长（需要 audio）' }),
  loopAudio: booleanParam('loopAudio')
    .default(false)
    .meta({ description: '音频比视频短时循环播放，默认 false（之后静音）' }),
  audioFadeIn: numberParam('audioFadeIn', { min: 0, max: 30 })
    .default(0)
    .meta({ description: '音频开头淡入秒数（0-30），默认 0' }),
  audioFadeOut: numberParam('audioFadeOut', { min: 0, max: 30 })
    .default(2)
    .meta({ description: '音频结尾淡出秒数（0-30），默认 2' }),
});

type Params = z.output<typeof params>;

export interface SlideshowPlan {
  /** 每张图的帧数（含与相邻图重叠的转场） */
  frames: number[];
  /** 转场帧数，0 表示无转场 */
  transitionFrames: number;
  /** 第 i 张图在成片里的起始帧 */
  starts: number[];
  totalFrames: number;
}

/**
 * 按帧计算时间轴，避免秒数累加的舍入误差：
 * 第 i 张图从 starts[i] 开始，持续 frames[i] 帧，与下一张重叠 transitionFrames 帧
 */
export function planSlideshow(opts: {
  count: number;
  fps: number;
  durationPerImage: number;
  transitionDuration: number;
  /** 有值时按这个总时长（秒）分配每张图的时长 */
  fitDuration?: number;
}): SlideshowPlan {
  const { count, fps } = opts;
  const transition = count > 1 ? opts.transitionDuration : 0;
  let transitionFrames = transition > 0 ? Math.max(1, Math.round(transition * fps)) : 0;
  // 转场不能超过单张图帧数的一半，否则一张图的转入和转出会重叠
  const half = (f: number[]) => Math.floor(Math.min(...f) / 2);
  let frames: number[];
  if (opts.fitDuration !== undefined) {
    const totalFrames = Math.max(1, Math.round(opts.fitDuration * fps));
    // 总帧数固定，转场越长每张图越长：T 帧转场时每张约 (total + (count-1)·T) / count 帧。
    // 先按 T ≤ total / (count + 1) 缩短转场，再按取整后的实际帧数逐帧修正，保证总帧数严格等于音频时长
    const split = (t: number) => {
      const sum = totalFrames + (count - 1) * t;
      const base = Math.floor(sum / count);
      return Array.from({ length: count }, (_, i) => base + (i < sum % count ? 1 : 0));
    };
    transitionFrames = Math.min(transitionFrames, Math.floor(totalFrames / (count + 1)));
    frames = split(transitionFrames);
    while (transitionFrames > half(frames)) frames = split(--transitionFrames);
    if (Math.min(...frames) < Math.max(1, Math.floor(MIN_IMAGE_SECONDS * fps))) {
      const need = count * MIN_IMAGE_SECONDS - (count - 1) * Math.min(transition, 0.25);
      throw new Error(
        `音频太短：${count} 张图每张至少显示 ${MIN_IMAGE_SECONDS} 秒，需要约 ${num(need)} 秒以上的音频`,
      );
    }
  } else {
    const per = Math.max(1, Math.round(opts.durationPerImage * fps));
    frames = new Array<number>(count).fill(per);
    transitionFrames = Math.min(transitionFrames, half(frames));
  }
  const starts = [0];
  for (let i = 1; i < count; i++) starts.push(starts[i - 1] + frames[i - 1] - transitionFrames);
  return {
    frames,
    transitionFrames,
    starts,
    totalFrames: starts[count - 1] + frames[count - 1],
  };
}

export interface ChunkPlan {
  /** 本段用到的图片序号（含与下一段衔接的那张） */
  images: number[];
  /** 本段渲染结果的截取范围（段内帧号，左闭右开） */
  trimStart: number;
  trimEnd: number;
}

/**
 * 分段：每段 CHUNK_IMAGES 张图。有转场时把下一段的第一张也带上，渲染完整的转场后截到
 * 「下一张图完全出现」为止；下一段从这张图转场结束处开始。各段首尾相接，拼起来与一次渲染完全相同
 */
export function planChunks(plan: SlideshowPlan, chunkSize = CHUNK_IMAGES): ChunkPlan[] {
  const n = plan.frames.length;
  const t = plan.transitionFrames;
  const chunks: ChunkPlan[] = [];
  for (let s = 0; s < n; s += chunkSize) {
    const e = Math.min(n, s + chunkSize);
    const lookahead = t > 0 && e < n;
    const images = Array.from({ length: e - s }, (_, i) => s + i);
    if (lookahead) images.push(e);
    const origin = plan.starts[s];
    chunks.push({
      images,
      trimStart: s > 0 ? t : 0,
      trimEnd: lookahead
        ? plan.starts[e] - origin + t
        : plan.starts[e - 1] + plan.frames[e - 1] - origin,
    });
  }
  return chunks;
}

/** Ken Burns 的四种运动轮换：推近、拉远、左移、右移。表达式里没有逗号和冒号，不用转义 */
function kenBurnsFilter(index: number, frames: number, size: OutputSize, fps: string): string {
  const span = Math.max(1, frames - 1);
  const z = KEN_BURNS_ZOOM;
  const center = { x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' };
  const motions = [
    { z: `1+${z}*on/${span}`, ...center },
    { z: `${1 + z}-${z}*on/${span}`, ...center },
    { z: `${1 + z}`, x: `(iw-iw/zoom)*on/${span}`, y: center.y },
    { z: `${1 + z}`, x: `(iw-iw/zoom)*(1-on/${span})`, y: center.y },
  ];
  const m = motions[index % motions.length];
  return `zoompan=z=${m.z}:x=${m.x}:y=${m.y}:d=${frames}:s=${size.width}x${size.height}:fps=${fps}`;
}

function pickTransition(p: Params): string {
  if (p.transition !== 'random') return p.transition;
  return RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
}

function chunkGraph(
  chunk: ChunkPlan,
  plan: SlideshowPlan,
  p: Params,
  fps: string,
  transitions: string[],
): string {
  const parts: string[] = [];
  chunk.images.forEach((img, k) => {
    const frames = plan.frames[img];
    const motion = p.kenBurns
      ? kenBurnsFilter(img, frames, p.size, fps)
      : // 单帧图片用 loop 复制成 frames 帧，引用同一块内存，不重复解码。
        // 静帧的时间基是 1/1，直接 setpts=N/(fps*TB) 会把时间戳截成 0、fps 滤镜随之丢帧，先换成微秒时间基
        `loop=loop=${frames - 1}:size=1:start=0,settb=AVTB,setpts=N/(${fps}*TB),fps=${fps}`;
    parts.push(`[${k}:v]${motion},setsar=1,format=yuv420p[v${k}]`);
  });
  const origin = plan.starts[chunk.images[0]];
  let last = 'v0';
  if (chunk.images.length > 1) {
    if (plan.transitionFrames > 0) {
      const duration = num(plan.transitionFrames / Number(fps));
      for (let k = 1; k < chunk.images.length; k++) {
        const offset = num((plan.starts[chunk.images[k]] - origin) / Number(fps));
        const out = `x${k}`;
        parts.push(
          `[${last}][v${k}]xfade=transition=${transitions[chunk.images[k] - 1]}:duration=${duration}:offset=${offset}[${out}]`,
        );
        last = out;
      }
    } else {
      const labels = chunk.images.map((_, k) => `[v${k}]`).join('');
      parts.push(`${labels}concat=n=${chunk.images.length}:v=1:a=0[cat]`);
      last = 'cat';
    }
  }
  parts.push(
    `[${last}]trim=start_frame=${chunk.trimStart}:end_frame=${chunk.trimEnd},setpts=PTS-STARTPTS[out]`,
  );
  return parts.join(';\n');
}

async function renderChunks(
  ctx: OperationContext,
  p: Params,
  plan: SlideshowPlan,
  fps: string,
  share: number,
): Promise<{ file: string; frames: number }[]> {
  const images = ctx.inputs.images;
  const chunks = planChunks(plan);
  const transitions = images.slice(1).map(() => pickTransition(p));
  // Ken Burns 在放大两倍的图上取景，减轻 zoompan 按整数像素取景造成的抖动
  const upscale = p.kenBurns && p.size.width * p.size.height <= 1920 * 1080 ? 2 : 1;
  const stillSize = { width: p.size.width * upscale, height: p.size.height * upscale };
  const fit: FitMode = p.fit;
  const ready = new Set<number>();
  const segments: { file: string; frames: number }[] = [];
  let done = 0;

  for (let c = 0; c < chunks.length; c++) {
    ctx.signal.throwIfAborted();
    const chunk = chunks[c];
    const frames = chunk.trimEnd - chunk.trimStart;
    const start = (done / plan.totalFrames) * share;
    const end = ((done + frames) / plan.totalFrames) * share;
    const stillEnd = start + (end - start) * 0.2;

    const pending = chunk.images.filter((i) => !ready.has(i));
    for (let k = 0; k < pending.length; k++) {
      const i = pending[k];
      const from = start + ((stillEnd - start) * k) / pending.length;
      const to = start + ((stillEnd - start) * (k + 1)) / pending.length;
      await renderStill(ctx, images[i], {
        fit,
        size: stillSize,
        background: p.backgroundColor,
        name: `still${i}.y4m`,
        label: `第 ${i + 1} 张图片`,
        checked: true,
        range: [from, to],
      });
      ready.add(i);
    }

    const graphFile = ctx.tempPath(`chunk${c}.txt`);
    await fs.promises.writeFile(graphFile, chunkGraph(chunk, plan, p, fps, transitions));
    const segment = ctx.tempPath(`chunk${c}.mp4`);
    const args: string[] = [];
    for (const i of chunk.images) args.push('-i', ctx.tempPath(`still${i}.y4m`));
    // 滤镜图写进文件（-/filter_complex）：100 张图的 Ken Burns 表达式拼在命令行里会超过 Windows 32K 的长度限制
    args.push('-/filter_complex', graphFile, '-map', '[out]', ...X264_ARGS, '-an', '-y', segment);
    await ctx.ffmpeg(args, {
      duration: frames / Number(fps),
      range: [stillEnd, end],
    });
    segments.push({ file: segment, frames });
    done += frames;

    // 用完的中间图删掉，100 张 1080p 的 y4m 要占 300 MB 以上
    const keep = chunks[c + 1]?.images[0];
    for (const i of chunk.images) {
      if (i !== keep) {
        await fs.promises.rm(ctx.tempPath(`still${i}.y4m`), { force: true });
        ready.delete(i);
      }
    }
  }
  return segments;
}

export const slideshow = defineOperation({
  name: 'video.slideshow',
  route: '/api/video/slideshow',
  title: '图片幻灯片',
  description:
    '把多张图片做成幻灯片视频：58 种 xfade 转场（含随机）、Ken Burns 运动效果、背景音乐，可按音乐长度自动分配每张图的时长。',
  inputs: [
    {
      name: 'images',
      kind: 'image',
      required: true,
      multiple: { min: 1, max: 100 },
      description: '图片，按上传顺序播放（1-100 张，尺寸和格式可以不同）',
    },
    { name: 'audio', kind: 'audio', required: false, description: '背景音乐' },
  ],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/video/slideshow \\',
    '  -F "images=@1.jpg" -F "images=@2.png" -F "images=@3.webp" -F "audio=@bgm.mp3" \\',
    '  -F "transition=random" -F "kenBurns=true" -F "fitToAudio=true"',
    '',
    '# URL 输入',
    'curl -X POST http://localhost:9527/api/video/slideshow \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"imagesUrls":["https://example.com/1.jpg","https://example.com/2.jpg"],',
    '       "durationPerImage":4,"transition":"slideleft","size":"1080x1920","fit":"blur"}\'',
  ].join('\n'),
  notes: [
    '时长：不开 fitToAudio 时为 图片数 × durationPerImage − (图片数 − 1) × transitionDuration；开启时等于音频时长，最长 4 小时。',
    '每张图只解码一次并缩放到输出尺寸，尺寸、格式（jpg / png / webp / gif / bmp …）可以混用，透明部分填 backgroundColor，动图只取第一帧；单张图片上限 1 亿像素。',
    '每 10 张图分一段渲染再流复制拼接，100 张图的内存占用与 10 张相当。',
    '有音频时：比视频长的部分截掉，结尾按 audioFadeOut 淡出；比视频短时补静音，或 loopAudio=true 无缝循环。没有音频时输出无音轨的视频。',
    'transitionDuration 不能超过 durationPerImage 的一半；fitToAudio 时按需要自动缩短转场。',
    '分辨率最大 3840x2160，帧率 1-60。',
  ],
  check(p, provided) {
    const count = provided.images ?? 0;
    const hasAudio = (provided.audio ?? 0) > 0;
    if (p.fitToAudio && !hasAudio) return 'fitToAudio=true 需要上传 audio 音频';
    if (
      !p.fitToAudio &&
      count > 1 &&
      p.transition !== 'none' &&
      p.transitionDuration > p.durationPerImage / 2
    ) {
      return 'transitionDuration 不能超过 durationPerImage 的一半（每张图的转入和转出不能重叠）';
    }
    return undefined;
  },
  async run(ctx, p) {
    const images = ctx.inputs.images;
    const audioFile = ctx.inputs.audio?.[0];
    // 先检查所有图片和音频，避免渲染到一半才发现第 87 张图是坏的
    await mapLimit(images, 4, (file, i) => checkImage(ctx, file, `第 ${i + 1} 张图片`));
    let audioDuration = 0;
    if (audioFile) {
      const media = await probeOrThrow((f) => ctx.probe(f), audioFile, '音频');
      // 优先用音轨自身的时长：拿视频文件当音频时，整个文件的时长可能是更长的画面
      audioDuration = requireAudio(media, '音频文件').duration || media.duration;
      if (!(audioDuration > 0)) throw new Error('无法确定音频时长');
    }
    if (p.fitToAudio && audioDuration > MAX_GENERATED_SECONDS) {
      throw new Error('音频超过 4 小时上限');
    }

    const fps = num(p.fps);
    const plan = planSlideshow({
      count: images.length,
      fps: p.fps,
      durationPerImage: p.durationPerImage,
      transitionDuration: p.transition === 'none' ? 0 : p.transitionDuration,
      fitDuration: p.fitToAudio ? audioDuration : undefined,
    });
    const total = plan.totalFrames / p.fps;
    if (total > MAX_GENERATED_SECONDS) throw new Error('输出超过 4 小时上限');

    const segments = await renderChunks(ctx, p, plan, fps, 0.95);

    // 各段编码参数完全相同，concat 分离器直接流复制；duration 写明每段帧数对应的时长，时间戳不会漂移
    const list = ['ffconcat version 1.0'];
    for (const s of segments) {
      list.push(`file '${s.file.split(/[\\/]/).pop()}'`, `duration ${num(s.frames / p.fps)}`);
    }
    const listFile = ctx.tempPath('chunks.txt');
    await fs.promises.writeFile(listFile, list.join('\n') + '\n');

    const args = ['-f', 'concat', '-i', listFile];
    let final: [number, number] = [0.95, 1];
    if (audioFile) {
      const looping = p.loopAudio && audioDuration < total;
      if (looping) {
        // 循环先解码好的 PCM：压缩音频直接 -stream_loop 接缝处有空洞，见 decodeLoopAudio
        const pcm = await decodeLoopAudio(ctx, audioFile, audioDuration, [0.95, 0.96]);
        args.push('-stream_loop', '-1', '-i', pcm);
        final = [0.96, 1];
      } else {
        args.push('-i', audioFile);
      }
      const end = looping ? total : Math.min(total, audioDuration);
      const chain = [
        `atrim=end=${num(end)}`,
        'asetpts=PTS-STARTPTS',
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      ];
      const fadeIn = Math.min(p.audioFadeIn, end);
      const fadeOut = Math.min(p.audioFadeOut, end);
      if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(fadeIn)}`);
      if (fadeOut > 0) chain.push(`afade=t=out:st=${num(end - fadeOut)}:d=${num(fadeOut)}`);
      chain.push(`apad=whole_dur=${num(total)}`, `atrim=end=${num(total)}`);
      args.push('-filter_complex', `[1:a]${chain.join(',')}[a]`, '-map', '0:v', '-map', '[a]');
      args.push('-c:v', 'copy', ...AAC_ARGS);
    } else {
      args.push('-map', '0:v', '-c:v', 'copy');
    }
    const output = ctx.outputPath('mp4');
    args.push('-t', num(total), '-movflags', '+faststart', '-y', output);
    await ctx.ffmpeg(args, { duration: total, range: final });
    return { files: [output] };
  },
});
