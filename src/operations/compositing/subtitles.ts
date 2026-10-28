import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { booleanParam, colorParam, enumParam, numberParam } from '../../schemas/coerce';
import { configuredFont, stageFontFile } from '../../utils/fonts';
import { defineOperation, type OperationContext } from '../types';
import { toAssColor } from './colors';
import {
  EVEN_SCALE,
  X264_ARGS,
  assertOutputPixels,
  audioPassthroughArgs,
  displaySize,
  num,
  probeOrThrow,
  probeStreamFacts,
  requireVideo,
  videoPassthroughArgs,
  type Container,
} from './common';
import { fontFileFamily, isSafeFamilyName } from './font-family';
import {
  FFMPEG_TEXT_SUBTITLE_INFO,
  MAX_SUBTITLE_BYTES,
  SUBTITLE_ENCODINGS,
  assScriptInfo,
  decodeSubtitle,
  detectSubtitleFormat,
  normalizeSubtitleText,
  shiftSubtitle,
  type SubtitleFormat,
} from './subtitle-file';

const MAX_TEXT_BYTES = 60 * 1024;
const TEXT_FORMAT_ERROR =
  'text 不是有效的 SRT 或 WebVTT 字幕内容（需要 00:00:01,000 --> 00:00:02,000 这样的时间轴）';

const params = z.object({
  mode: enumParam('mode', ['burn', 'soft']).default('burn').meta({
    description:
      'burn：把字幕烧录进画面（重新编码）；soft：作为可开关的字幕轨封装（画面流复制，很快）',
  }),
  text: z
    .string({ error: 'text 必须是字符串' })
    .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_TEXT_BYTES, {
      error: 'text 字幕内容不能超过 60 KB，更大的字幕请上传文件',
    })
    .refine((s) => detectSubtitleFormat(normalizeSubtitleText(s)) !== undefined, {
      error: TEXT_FORMAT_ERROR,
    })
    .optional()
    .meta({ description: '直接传字幕内容（SRT 或 WebVTT 文本，≤ 60 KB），代替上传 subtitle 文件' }),
  encoding: enumParam('encoding', SUBTITLE_ENCODINGS).default('auto').meta({
    description:
      '字幕文件编码。auto：按 BOM / UTF-8 / UTF-16 自动识别，都不是时按 GB18030（兼容 GBK）解码',
  }),
  offset: numberParam('offset', { min: -3600, max: 3600 }).default(0).meta({
    description:
      '字幕整体平移的秒数（-3600 到 3600），正数推迟、负数提前；提前到 0 秒之前的字幕丢弃',
  }),
  container: enumParam('container', ['mp4', 'mkv']).default('mp4').meta({
    description: '输出容器。soft 模式下 mp4 的字幕轨是 mov_text（会丢失 ASS 样式），mkv 保留原格式',
  }),
  language: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
      z.string({ error: 'language 必须是字符串' }).regex(/^[a-z]{3}$/, {
        error:
          'language 必须是 3 个字母的 ISO 639-2 语言代码，如 chi（中文）、eng（英文）、jpn（日文）',
      }),
    )
    .optional()
    .meta({ description: 'soft 模式：字幕轨的语言（ISO 639-2，如 chi、eng、jpn）' }),
  fontSize: numberParam('fontSize', { min: 4, max: 400 })
    .optional()
    .meta({ description: 'burn 模式：字号，单位是输出画面的像素（文字高度约为字号）' }),
  fontColor: colorParam('fontColor')
    .optional()
    .meta({ description: 'burn 模式：文字颜色，如 white、#FFD700、yellow@0.8' }),
  outlineColor: colorParam('outlineColor').optional().meta({ description: 'burn 模式：描边颜色' }),
  outline: numberParam('outline', { min: 0, max: 10 })
    .optional()
    .meta({ description: 'burn 模式：描边宽度（像素，0-10）；设置了 boxColor 时是底框的内边距' }),
  shadow: numberParam('shadow', { min: 0, max: 10 })
    .optional()
    .meta({ description: 'burn 模式：阴影偏移（像素，0-10）' }),
  boxColor: colorParam('boxColor').optional().meta({
    description: 'burn 模式：设置后文字下方加底框（如 black@0.6），此时 outlineColor 不生效',
  }),
  bold: booleanParam('bold').optional().meta({ description: 'burn 模式：粗体' }),
  italic: booleanParam('italic').optional().meta({ description: 'burn 模式：斜体' }),
  position: enumParam('position', ['bottom', 'top', 'middle'])
    .optional()
    .meta({ description: 'burn 模式：字幕垂直位置，默认 bottom' }),
  align: enumParam('align', ['left', 'center', 'right'])
    .optional()
    .meta({ description: 'burn 模式：水平对齐，默认 center' }),
  marginV: numberParam('marginV', { min: 0, max: 4000, int: true })
    .optional()
    .meta({ description: 'burn 模式：与画面上 / 下边缘的距离（像素）' }),
  overrideFont: booleanParam('overrideFont').optional().meta({
    description:
      'burn 模式：ASS 字幕也强制使用服务器配置的字体（ASS 里指定的字体服务器上没有、出现方框或空白时打开）。SRT / WebVTT 总是使用服务器字体',
  }),
});

type Params = z.output<typeof params>;

const STYLE_KEYS = [
  'fontSize',
  'fontColor',
  'outlineColor',
  'outline',
  'shadow',
  'boxColor',
  'bold',
  'italic',
  'position',
  'align',
  'marginV',
] as const;

// force_style 的 Alignment 按 libass 的旧式（SSA）取值解析：1-3 底部、5-7 顶部、9-11 居中，
// 不是 [V4+ Styles] 里的小键盘数字（2026-10 实测 libass 0.17.5）
const H_ALIGN = { left: 1, center: 2, right: 3 } as const;
const V_ALIGN = { bottom: 0, top: 4, middle: 8 } as const;

const round2 = (n: number) => num(Math.round(n * 100) / 100);

// Matroska 能直接装下的字幕编码（文本和 DVD / 蓝光 / DVB 图形字幕）
const MKV_SUBTITLE_COPY = new Set([
  'subrip',
  'ass',
  'webvtt',
  'text',
  'dvd_subtitle',
  'hdmv_pgs_subtitle',
  'dvb_subtitle',
]);
// Matroska 装不下、但 FFmpeg 能解码成文本的字幕：mp4 / mov 的 mov_text（tx3g）
const MKV_SUBTITLE_TO_SRT = new Set(['mov_text']);

/** 原有字幕轨封装进 mkv 用的编码器：copy、srt，装不下也转不了时返回 undefined（丢弃这条轨） */
function mkvSubtitleEncoder(codec: string): 'copy' | 'srt' | undefined {
  if (MKV_SUBTITLE_COPY.has(codec)) return 'copy';
  if (MKV_SUBTITLE_TO_SRT.has(codec)) return 'srt';
  return undefined;
}

interface FontSetup {
  /** fontsdir 选项的值（workDir 里的子目录名），没有字体文件时不传 */
  dir?: string;
  family?: string;
}

/**
 * 把配置的字体放进 workDir/fonts 交给 libass（fontsdir），并读出族名用于 FontName。
 * 没有 fontconfig 的环境里 libass 只认 fontsdir 里的字体，FontName 对不上就会退回到不存在的 Arial。
 * 和文字水印（drawtext 的 fontfile）一样，FONT_FILE 优先于 FONT_NAME
 */
async function setupFont(ctx: OperationContext): Promise<FontSetup> {
  const font = configuredFont();
  const setup: FontSetup = {};
  if (font.file && fs.existsSync(font.file)) {
    const dir = path.join(ctx.workDir, 'fonts');
    await fs.promises.mkdir(dir, { recursive: true });
    await stageFontFile(font.file, dir);
    setup.dir = 'fonts';
    setup.family = await fontFileFamily(font.file, font.name);
    if (!setup.family) {
      ctx.log(
        `FONT_FILE 字体文件里读不出英文族名，字幕改用${font.name ? ` FONT_NAME（${font.name}）` : '默认字体'}`,
      );
      setup.family = font.name;
    }
  } else {
    if (font.file) ctx.log('FONT_FILE 指向的字体文件不存在，字幕改用 FONT_NAME 或默认字体');
    setup.family = font.name;
  }
  if (setup.family && !isSafeFamilyName(setup.family)) setup.family = undefined;
  return setup;
}

function buildForceStyle(
  p: Params,
  format: SubtitleFormat,
  content: string,
  frameHeight: number,
  family: string | undefined,
): string[] {
  const info = format === 'ass' ? assScriptInfo(content) : FFMPEG_TEXT_SUBTITLE_INFO;
  // 样式数值以脚本分辨率 PlayResY 为单位，libass 渲染时乘以 视频高 / PlayResY。参数按输出像素给，这里换算回去
  const scale = info.playResY / frameHeight;
  const borderScale = info.scaledBorder ? scale : 1;
  const styles: string[] = [];
  if (family && (format !== 'ass' || p.overrideFont)) styles.push(`FontName=${family}`);
  if (p.fontSize !== undefined) styles.push(`FontSize=${round2(p.fontSize * scale)}`);
  if (p.fontColor) styles.push(`PrimaryColour=${toAssColor(p.fontColor)}`);
  if (p.boxColor) {
    // BorderStyle=3 是不透明底框，libass 用 OutlineColour 画框
    styles.push('BorderStyle=3', `OutlineColour=${toAssColor(p.boxColor)}`);
  } else if (p.outlineColor) {
    styles.push(`OutlineColour=${toAssColor(p.outlineColor)}`);
  }
  if (p.outline !== undefined) styles.push(`Outline=${round2(p.outline * borderScale)}`);
  if (p.shadow !== undefined) styles.push(`Shadow=${round2(p.shadow * borderScale)}`);
  if (p.bold !== undefined) styles.push(`Bold=${p.bold ? -1 : 0}`);
  if (p.italic !== undefined) styles.push(`Italic=${p.italic ? -1 : 0}`);
  if (p.position || p.align) {
    styles.push(`Alignment=${H_ALIGN[p.align ?? 'center'] + V_ALIGN[p.position ?? 'bottom']}`);
  }
  if (p.marginV !== undefined) styles.push(`MarginV=${Math.round(p.marginV * scale)}`);
  return styles;
}

async function loadSubtitle(
  ctx: OperationContext,
  p: Params,
): Promise<{ format: SubtitleFormat; content: string; file: string }> {
  let content: string;
  const source = ctx.inputs.subtitle?.[0];
  if (source) {
    const { size } = await fs.promises.stat(source);
    if (size > MAX_SUBTITLE_BYTES) throw new Error('字幕文件超过 20 MB，不像是文本字幕');
    content = decodeSubtitle(await fs.promises.readFile(source), p.encoding);
  } else if (p.text) {
    content = normalizeSubtitleText(p.text);
  } else {
    throw new Error('缺少字幕：请上传 subtitle 文件或传 text');
  }
  const format = detectSubtitleFormat(content);
  if (!format) {
    throw new Error(
      '字幕格式无法识别，只支持 SRT、ASS / SSA、WebVTT 文本字幕（如果是乱码，试试指定 encoding）',
    );
  }
  if (p.offset) {
    const shifted = shiftSubtitle(content, format, p.offset);
    if (shifted.cues === 0) {
      throw new Error(`字幕整体平移 ${num(p.offset)} 秒后没有剩下任何字幕（全部落在 0 秒之前）`);
    }
    content = shifted.text;
  }
  // 字幕交给 FFmpeg 时只写文件名：滤镜参数里出现路径就要处理冒号、反斜杠等多层转义
  const file = `sub.${format}`;
  await fs.promises.writeFile(ctx.tempPath(file), content, 'utf8');
  return { format, content, file };
}

async function burn(
  ctx: OperationContext,
  p: Params,
  input: string,
  sub: { format: SubtitleFormat; content: string; file: string },
): Promise<string> {
  const media = await probeOrThrow((f) => ctx.probe(f), input, '视频');
  const video = requireVideo(media, '输入文件');
  const facts = await probeStreamFacts(input, ctx.signal).catch(() => ({ rotation: 0 }));
  const frame = displaySize(video, facts.rotation);
  assertOutputPixels(frame.width, frame.height, '视频');

  const font = await setupFont(ctx);
  const styles = buildForceStyle(p, sub.format, sub.content, frame.height, font.family);
  let subtitles = `subtitles=filename=${sub.file}`;
  if (font.dir) subtitles += `:fontsdir=${font.dir}`;
  // force_style 的值都是数字、&H 颜色或校验过的字体族名，不含引号和逗号以外的特殊字符
  if (styles.length) subtitles += `:force_style='${styles.join(',')}'`;

  const filters = [subtitles];
  if (frame.width % 2 || frame.height % 2) filters.push(EVEN_SCALE);

  const container: Container = p.container;
  const output = ctx.outputPath(container);
  const args = [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    filters.join(','),
    ...X264_ARGS,
  ];
  args.push(...(media.audio ? audioPassthroughArgs(media.audio, container) : ['-an']));
  if (container === 'mp4') args.push('-movflags', '+faststart');
  args.push('-y', output);
  await ctx.ffmpeg(args, { duration: media.duration });
  return output;
}

async function soft(
  ctx: OperationContext,
  p: Params,
  input: string,
  sub: { format: SubtitleFormat; file: string },
): Promise<string> {
  const media = await probeOrThrow((f) => ctx.probe(f), input, '视频');
  const video = requireVideo(media, '输入文件');
  const container: Container = p.container;
  const args = ['-i', input, '-i', ctx.tempPath(sub.file), '-map', '0:v:0', '-map', '0:a?'];

  // mkv 保留原有字幕轨，新字幕排在最后；mp4 只能装 mov_text，原有字幕轨丢弃
  const kept: ('copy' | 'srt')[] = [];
  if (container === 'mkv') {
    const { subtitleCodecs } = await probeStreamFacts(input, ctx.signal);
    subtitleCodecs.forEach((codec, i) => {
      const encoder = mkvSubtitleEncoder(codec);
      if (encoder) {
        args.push('-map', `0:s:${i}`);
        kept.push(encoder);
      } else {
        ctx.log(`原有第 ${i + 1} 条字幕轨（${codec || '未知编码'}）mkv 装不下，已丢弃`);
      }
    });
    // 原有 ASS 字幕依赖 mkv 附件里的字体，一起保留
    if (kept.length) args.push('-map', '0:t?');
  }
  const existing = kept.length;
  args.push('-map', '1:0');
  args.push(...videoPassthroughArgs(video, container));
  if (media.audio) args.push(...audioPassthroughArgs(media.audio, container));
  if (container === 'mp4') {
    args.push('-c:s', 'mov_text');
  } else {
    kept.forEach((encoder, k) => args.push(`-c:s:${k}`, encoder));
    // WebVTT 装进 mkv 很多播放器不认，转成 SRT；SRT、ASS 原样复制
    args.push(`-c:s:${existing}`, sub.format === 'vtt' ? 'srt' : 'copy');
  }
  if (p.language) args.push(`-metadata:s:s:${existing}`, `language=${p.language}`);
  if (container === 'mp4') args.push('-movflags', '+faststart');
  const output = ctx.outputPath(container);
  args.push('-y', output);
  await ctx.ffmpeg(args, { duration: media.duration });
  return output;
}

export const subtitles = defineOperation({
  name: 'video.subtitles',
  route: '/api/video/subtitles',
  title: '添加字幕',
  description:
    '给视频加字幕：烧录进画面（支持字号、颜色、描边、底框、位置等样式），或封装成可开关的字幕轨。支持 SRT、ASS / SSA、WebVTT。',
  inputs: [
    { name: 'file', kind: 'video', required: true, description: '视频文件' },
    {
      name: 'subtitle',
      kind: 'subtitle',
      required: false,
      description: '字幕文件（SRT、ASS / SSA、WebVTT），也可以用 text 参数直接传内容',
    },
  ],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/subtitles \\',
    '  -F "file=@video.mp4" -F "subtitle=@zh.srt" \\',
    '  -F "fontSize=40" -F "fontColor=yellow" -F "outline=2" -F "position=bottom"',
    '',
    '# URL 输入 + 内嵌字幕文本，封装成软字幕',
    'curl -X POST http://localhost:9527/api/video/subtitles \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","mode":"soft","language":"chi",',
    '       "text":"1\\n00:00:00,000 --> 00:00:02,000\\n你好，世界\\n"}\'',
  ].join('\n'),
  notes: [
    '字幕格式按内容识别，不看扩展名；非 UTF-8 的字幕自动按 GB18030（兼容 GBK）解码，也可以用 encoding 指定。',
    'burn 模式重新编码画面（H.264 CRF 23），音轨流复制；soft 模式画面和音轨都流复制（mp4 装不下的编码会转成 H.264 / AAC）。',
    'burn 模式用服务器配置的字体渲染 SRT / WebVTT，中文可正常显示：设置了 FONT_FILE 时用这个字体文件（与文字水印一致，FONT_NAME 只用来在 .ttc 字体集合里挑一个），否则用 FONT_NAME，Windows 默认微软雅黑；ASS 字幕默认用文件里指定的字体，服务器上没有时打开 overrideFont。',
    'fontSize、outline、shadow、marginV 都按输出画面像素计算，不受字幕脚本分辨率影响；样式参数只在 burn 模式生效，ASS 字幕只有显式传入的样式才会覆盖原样式。',
    'soft 模式：mp4 的字幕轨是 mov_text（ASS 样式会丢失，原有字幕轨不保留）；mkv 保留 ASS 样式和原有字幕轨，WebVTT 转成 SRT；原有的 mov_text 字幕（mp4 / mov 输入）转成 SRT，其他 mkv 装不下的字幕轨丢弃并记在任务日志里。',
    'offset 直接改写字幕文本里的时间轴（burn 和 soft 都适用）：结束时间早于 0 秒的字幕丢弃，跨过 0 秒的从 0 秒开始。',
    'text 不超过 60 KB，字幕文件不超过 20 MB。',
  ],
  check(p, provided) {
    const hasFile = (provided.subtitle ?? 0) > 0;
    if (!hasFile && !p.text)
      return '缺少字幕：请上传 subtitle 文件（或传 subtitleUrl），或用 text 直接传字幕内容';
    if (hasFile && p.text) return 'subtitle 文件和 text 只能二选一';
    return undefined;
  },
  async run(ctx, p) {
    const input = ctx.inputs.file[0];
    const sub = await loadSubtitle(ctx, p);
    if (p.mode === 'soft') {
      const ignored = STYLE_KEYS.filter((k) => p[k] !== undefined);
      if (ignored.length) ctx.log(`soft 模式忽略样式参数: ${ignored.join(', ')}`);
      return { files: [await soft(ctx, p, input, sub)] };
    }
    return { files: [await burn(ctx, p, input, sub)] };
  },
});
