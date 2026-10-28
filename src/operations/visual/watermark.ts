import fs from 'fs';
import { z } from 'zod';
import { colorParam, enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { drawtextFontOption } from '../../utils/fonts';
import { defineOperation, type OperationContext } from '../types';
import {
  MAX_WIDTH,
  assertOutputSize,
  formatSeconds,
  probeVideo,
  squarePixelFilters,
} from './shared';

const POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
type Position = (typeof POSITIONS)[number];

const MOTIONS = ['none', 'scroll', 'bounce'] as const;
type Motion = (typeof MOTIONS)[number];

// mp4 里能直接流复制的音频编码；其余（pcm、vorbis 等）复制进 mp4 会失败，要转成 AAC
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac']);

const MAX_TEXT_LENGTH = 500;

const params = z.object({
  text: z
    .string({ error: 'text 必须是字符串' })
    .max(MAX_TEXT_LENGTH, { error: `text 最多 ${MAX_TEXT_LENGTH} 个字符` })
    .optional()
    .meta({ description: '文字水印内容，支持中文和换行（与 image 至少提供一个）' }),
  position: enumParam('position', POSITIONS)
    .default('bottom-right')
    .meta({ description: `水印位置：${POSITIONS.join('、')}，默认 bottom-right` }),
  imagePosition: enumParam('imagePosition', POSITIONS)
    .optional()
    .meta({ description: '同时有文字和图片时图片的位置，默认与 position 相同' }),
  margin: numberParam('margin', { min: 0, max: 2000, int: true })
    .default(10)
    .meta({ description: '水印距画面边缘的距离（像素），默认 10' }),
  fontSize: numberParam('fontSize', { min: 4, max: 1000 })
    .default(24)
    .meta({ description: '文字大小（像素），默认 24' }),
  fontColor: colorParam('fontColor')
    .default('white')
    .meta({ description: '文字颜色：颜色名、#RRGGBB 或 #RRGGBBAA，可带 @透明度，默认 white' }),
  boxColor: colorParam('boxColor')
    .optional()
    .meta({ description: '文字背景框颜色，如 black@0.5；不传则没有背景框' }),
  boxPadding: numberParam('boxPadding', { min: 0, max: 200, int: true })
    .optional()
    .meta({ description: '背景框内边距（像素），默认为字号的 30%' }),
  borderWidth: numberParam('borderWidth', { min: 0, max: 20, int: true })
    .default(0)
    .meta({ description: '文字描边宽度（像素），默认 0 不描边' }),
  borderColor: colorParam('borderColor')
    .default('black')
    .meta({ description: '文字描边颜色，默认 black' }),
  shadowColor: colorParam('shadowColor')
    .optional()
    .meta({ description: '文字阴影颜色，如 black@0.6；不传则没有阴影' }),
  shadowOffset: numberParam('shadowOffset', { min: 1, max: 50, int: true })
    .default(2)
    .meta({ description: '文字阴影向右下的偏移（像素），默认 2' }),
  opacity: numberParam('opacity', { min: 0, max: 1 })
    .default(1)
    .meta({ description: '水印不透明度 0-1，同时作用于文字和图片，默认 1' }),
  imageWidth: numberParam('imageWidth', { min: 2, max: MAX_WIDTH, int: true })
    .optional()
    .meta({ description: '图片水印缩放到的宽度（像素），高度等比；不传保持原尺寸' }),
  imageScale: numberParam('imageScale', { min: 0.01, max: 1 })
    .optional()
    .meta({ description: '图片水印宽度占视频宽度的比例（0.01-1），如 0.15；与 imageWidth 二选一' }),
  startTime: timeParam('startTime')
    .optional()
    .meta({ description: '水印开始出现的时间（秒或 HH:MM:SS），默认从头开始' }),
  endTime: timeParam('endTime')
    .optional()
    .meta({ description: '水印消失的时间（秒或 HH:MM:SS），默认持续到结尾' }),
  motion: enumParam('motion', MOTIONS).default('none').meta({
    description:
      '水印运动方式：none 固定；scroll 从右向左循环滚动（跑马灯，垂直位置取 position）；bounce 在画面内来回反弹（防盗录）',
  }),
  speed: numberParam('speed', { min: 1, max: 5000 })
    .default(100)
    .meta({ description: 'scroll / bounce 的移动速度（像素/秒），默认 100' }),
});

type Params = z.output<typeof params>;

function axes(position: Position): {
  h: 'left' | 'center' | 'right';
  v: 'top' | 'center' | 'bottom';
} {
  if (position === 'center') return { h: 'center', v: 'center' };
  const [v, h] = position.split('-') as ['top' | 'center' | 'bottom', 'left' | 'center' | 'right'];
  return { h, v };
}

/** 浮点数拼进表达式：最多 4 位小数，不会出现科学计数法 */
function num(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

interface Placement {
  /** 画面宽高和水印宽高在各自滤镜里的变量名：drawtext 是 w/h/tw/th，overlay 是 W/H/w/h */
  W: string;
  H: string;
  w: string;
  h: string;
  /** 水印外缘到画面边缘的距离 */
  margin: number;
}

/**
 * 生成 x、y 表达式。表达式里都是自己拼的变量名和校验过的数字，外面套单引号，
 * 逗号在 filtergraph 里才不会被当成滤镜分隔符
 */
function placementExpr(
  position: Position,
  motion: Motion,
  speed: number,
  start: number,
  p: Placement,
): { x: string; y: string } {
  const { W, H, w, h } = p;
  const m = num(p.margin);
  const { h: horizontal, v: vertical } = axes(position);
  const t = start > 0 ? `(t-${num(start)})` : 't';
  const xFixed = { left: m, center: `(${W}-${w})/2`, right: `${W}-${w}-${m}` }[horizontal];
  const yFixed = { top: m, center: `(${H}-${h})/2`, bottom: `${H}-${h}-${m}` }[vertical];

  if (motion === 'scroll') {
    return { x: `${W}-mod(${t}*${num(speed)},${W}+${w})`, y: yFixed };
  }
  if (motion === 'bounce') {
    // 三角波 |mod(t·v + (1+k)·R, 2R) − R| 在 [0, R] 之间来回，t=0 时等于 k·R，即从 position 指定的位置出发；
    // 纵向速度取横向的 0.7 倍，轨迹不会只走对角线
    const phase = { left: 1, top: 1, center: 1.5, right: 2, bottom: 2 };
    const rangeX = `max(${W}-${w}-2*${m},1)`;
    const rangeY = `max(${H}-${h}-2*${m},1)`;
    const wave = (v: number, k: number, range: string) =>
      `${m}+abs(mod(${t}*${num(v)}+${k}*${range},2*${range})-${range})`;
    return {
      x: wave(speed, phase[horizontal], rangeX),
      y: wave(speed * 0.7, phase[vertical], rangeY),
    };
  }
  return { x: xFixed, y: yFixed };
}

function enableExpr(start: number | undefined, end: number | undefined): string {
  if (start !== undefined && end !== undefined) {
    return `:enable='between(t,${num(start)},${num(end)})'`;
  }
  if (start !== undefined) return `:enable='gte(t,${num(start)})'`;
  if (end !== undefined) return `:enable='lte(t,${num(end)})'`;
  return '';
}

/** 去掉控制字符（drawtext 会把它们画成方块），统一换行符，去掉首尾空行 */
export function cleanWatermarkText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/^\n+|\n+$/g, '');
}

async function buildDrawtext(ctx: OperationContext, text: string, p: Params): Promise<string> {
  // 文字写进 workDir 的文件、滤镜里只写文件名，用户输入不进入 filtergraph；expansion=none 让 % 原样显示
  await fs.promises.writeFile(ctx.tempPath('wm.txt'), text, 'utf8');
  const fontSize = Math.round(p.fontSize);
  const box = p.boxColor !== undefined;
  const boxPadding = p.boxPadding ?? Math.max(2, Math.round(fontSize * 0.3));
  // 背景框、描边画在文字外面，算位置时把它们也算进边距，贴边时才不会被裁掉
  const margin = p.margin + (box ? boxPadding : 0) + p.borderWidth;
  const { x, y } = placementExpr(p.position, p.motion, p.speed, p.startTime ?? 0, {
    W: 'w',
    H: 'h',
    w: 'tw',
    h: 'th',
    margin,
  });
  const align = { left: 'L', center: 'C', right: 'R' }[axes(p.position).h];
  const opts = ['textfile=wm.txt', 'expansion=none'];
  const font = await drawtextFontOption(ctx.workDir);
  if (font) opts.push(font);
  opts.push(`fontsize=${fontSize}`, `fontcolor=${p.fontColor}`, `text_align=${align}`);
  if (p.opacity < 1) opts.push(`alpha=${num(p.opacity)}`);
  if (box) opts.push('box=1', `boxcolor=${p.boxColor}`, `boxborderw=${boxPadding}`);
  if (p.borderWidth > 0) opts.push(`borderw=${p.borderWidth}`, `bordercolor=${p.borderColor}`);
  if (p.shadowColor !== undefined) {
    opts.push(
      `shadowcolor=${p.shadowColor}`,
      `shadowx=${p.shadowOffset}`,
      `shadowy=${p.shadowOffset}`,
    );
  }
  opts.push(`x='${x}'`, `y='${y}'`);
  return `drawtext=${opts.join(':')}${enableExpr(p.startTime, p.endTime)}`;
}

export const watermark = defineOperation({
  name: 'watermark',
  route: '/api/process/watermark',
  title: '添加水印',
  description:
    '给视频加文字水印、图片水印，或两者同时加。支持九宫格位置、透明度、背景框、描边、阴影、出现时间段，以及跑马灯滚动和防盗录反弹效果。',
  inputs: [
    { name: 'file', kind: 'video', required: true, description: '要加水印的视频' },
    {
      name: 'image',
      kind: 'image',
      required: false,
      description: '图片水印（png 可带透明通道），与 text 至少提供一个',
    },
  ],
  params,
  chainable: true,
  example: [
    '# 文字水印（中文、半透明背景框）',
    'curl -X POST http://localhost:9527/api/process/watermark \\',
    '  -F "file=@video.mp4" \\',
    '  -F "text=© 我的频道" \\',
    '  -F "position=top-right" \\',
    '  -F "fontSize=36" \\',
    '  -F "fontColor=yellow" \\',
    '  -F "boxColor=black@0.4"',
    '',
    '# 图片水印：宽度占视频 15%，半透明，只在 5-20 秒出现',
    'curl -X POST http://localhost:9527/api/process/watermark \\',
    '  -F "file=@video.mp4" \\',
    '  -F "image=@logo.png" \\',
    '  -F "imageScale=0.15" \\',
    '  -F "opacity=0.6" \\',
    '  -F "startTime=5" -F "endTime=20"',
    '',
    '# 用 URL 提交，文字在画面里反弹移动',
    'curl -X POST http://localhost:9527/api/process/watermark \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","text":"仅供内部预览","motion":"bounce","opacity":0.5}\'',
  ].join('\n'),
  notes: [
    'text 和 image 至少提供一个；两者都有时同时绘制，图片位置可用 imagePosition 单独指定，避免和文字重叠',
    `text 最多 ${MAX_TEXT_LENGTH} 个字符，可以换行；内容按原样绘制，% 等字符不会被当成模板`,
    '文字使用服务配置的字体（FONT_FILE / FONT_NAME），Docker 镜像自带中文字体',
    'fontColor、boxColor 等颜色只接受颜色名、#RRGGBB、#RRGGBBAA，可带 @透明度',
    '画面重新编码为 H.264（CRF 23）；音轨能直接放进 mp4 时原样复制，否则转为 AAC 192k。输出 mp4，索引在文件头',
    'startTime / endTime 控制水印出现的时间段；scroll / bounce 的运动从 startTime 开始计时',
    '水印图片本身和缩放后的尺寸都不能超过 7680 像素一边、总像素 7680x4320；动图（gif 等）只播放一遍后停在最后一帧，输出时长始终与原视频一致',
    '变形宽银幕（像素不是正方形）的视频先按显示比例拉正，输出为正方形像素，水印不会被拉伸；imageScale、margin 都按显示尺寸计算',
    '有多条音轨时只保留第一条（与旧版一致）；字幕轨、数据轨不保留',
    '与旧版的区别：旧版同时传 text 和 image 时只画文字，现在两者都画',
  ],
  check(p, provided) {
    if (!p.text && !provided.image) return '请提供 text 文字或上传 image 图片';
    if (p.text !== undefined && cleanWatermarkText(p.text) === '' && !provided.image) {
      return 'text 不能只包含空白或控制字符';
    }
    if (p.imageWidth !== undefined && p.imageScale !== undefined) {
      return 'imageWidth 和 imageScale 只能指定一个';
    }
    if (p.startTime !== undefined && p.endTime !== undefined && p.endTime <= p.startTime) {
      return '结束时间 endTime 必须大于开始时间 startTime';
    }
    return undefined;
  },
  async run(ctx, p) {
    const file = ctx.inputs.file[0];
    const logo = ctx.inputs.image?.[0];
    const info = await probeVideo(ctx, file, '视频');
    const text = p.text === undefined ? '' : cleanWatermarkText(p.text);
    if (!text && !logo) throw new Error('请提供 text 文字或上传 image 图片');

    const args = ['-i', file];
    const graph: string[] = [];
    let current = '[0:V:0]';
    // 变形宽银幕（像素不是正方形）先按显示比例拉正：imageScale 按显示宽度算，overlay / drawtext 却按存储像素画，
    // 不拉正时图片和文字都会被横向拉伸。输出与截图、转码等一样是正方形像素
    const square = squarePixelFilters(info);
    if (square.length) {
      graph.push(`${current}${square.join(',')}[sq]`);
      current = '[sq]';
    }

    if (logo) {
      const logoInfo = await ctx.probe(logo).catch((err: unknown) => {
        if (ctx.signal.aborted) throw err;
        throw new Error(`水印图片无法解析: ${err instanceof Error ? err.message : String(err)}`);
      });
      // 损坏的图片 ffprobe 也可能不报错，只是宽高为 0
      const logoVideo = logoInfo.video;
      if (!logoVideo || logoVideo.width <= 0 || logoVideo.height <= 0) {
        throw new Error('水印图片无法解析，请上传 png、jpg、webp 等图片');
      }
      // 解码一张超大图就要几百 MB 内存，缩放前先拦住
      assertOutputSize(logoVideo.width, logoVideo.height, '水印图片分辨率');
      args.push('-i', logo);

      const chain: string[] = [];
      const targetWidth =
        p.imageWidth ??
        (p.imageScale !== undefined
          ? Math.max(2, Math.round(info.width * p.imageScale))
          : undefined);
      if (targetWidth !== undefined) {
        const targetHeight = Math.max(
          1,
          Math.round((targetWidth * logoVideo.height) / logoVideo.width),
        );
        assertOutputSize(targetWidth, targetHeight, '缩放后的水印图片尺寸');
        chain.push(`scale=${targetWidth}:-1`);
      }
      chain.push('format=rgba');
      if (p.opacity < 1) chain.push(`colorchannelmixer=aa=${num(p.opacity)}`);
      graph.push(`[1:v:0]${chain.join(',')}[wm]`);

      const { x, y } = placementExpr(
        p.imagePosition ?? p.position,
        p.motion,
        p.speed,
        p.startTime ?? 0,
        { W: 'W', H: 'H', w: 'w', h: 'h', margin: p.margin },
      );
      graph.push(
        `${current}[wm]overlay=x='${x}':y='${y}'${enableExpr(p.startTime, p.endTime)}[ov]`,
      );
      current = '[ov]';
    }

    if (text) {
      graph.push(`${current}${await buildDrawtext(ctx, text, p)}[tx]`);
      current = '[tx]';
    }

    // libx264 + yuv420p 要求宽高是偶数。总是补这一步：拉正后的变形宽银幕、奇数尺寸的源都可能是奇数，
    // 宽高本来就是偶数时 scale 不做任何处理直接放行。去掉的 1 像素会让 scale 把 SAR 改成 213:212 这类值，setsar 保持正方形像素
    graph.push(`${current}scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[ev]`);
    current = '[ev]';

    const out = ctx.outputPath('mp4');
    args.push(
      '-filter_complex',
      graph.join(';'),
      '-map',
      current,
      // 只保留第一条音轨（与旧版的默认选流一致）；多条音轨编码不同时整体复制会失败
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
    );
    if (info.audio && !MP4_AUDIO.has(info.audio.codec)) args.push('-c:a', 'aac', '-b:a', '192k');
    else args.push('-c:a', 'copy');
    // overlay 默认在水印流比主画面长时（动图、视频当水印）冻结主画面的最后一帧继续输出，按原时长截断
    if (logo && info.duration > 0) args.push('-t', info.duration.toFixed(3));
    args.push('-movflags', '+faststart', '-y', out);

    if (p.startTime !== undefined && p.startTime >= info.duration) {
      ctx.log(
        `水印开始时间 ${formatSeconds(p.startTime)} 秒不早于视频时长 ${formatSeconds(info.duration)} 秒，水印不会出现`,
      );
    }
    await ctx.ffmpeg(args, { duration: info.duration });
    return { files: [out] };
  },
});
