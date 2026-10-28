export type SubtitleFormat = 'srt' | 'ass' | 'vtt';

export const SUBTITLE_ENCODINGS = [
  'auto',
  'utf-8',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-kr',
  'windows-1252',
  'utf-16le',
  'utf-16be',
] as const;
export type SubtitleEncoding = (typeof SUBTITLE_ENCODINGS)[number];

/** 字幕文件读入内存解码，太大的直接拒绝 */
export const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;

/** 没有 BOM 的 UTF-16：ASCII 字符的高字节是 0，看 0 字节集中在奇数还是偶数位置 */
function guessUtf16(buf: Buffer): 'utf-16le' | 'utf-16be' | undefined {
  const sample = buf.subarray(0, 4096);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2) odd++;
      else even++;
    }
  }
  const half = sample.length / 2;
  if (odd > half * 0.3 && even < odd / 10) return 'utf-16le';
  if (even > half * 0.3 && odd < even / 10) return 'utf-16be';
  return undefined;
}

/**
 * 字幕文件转成字符串。auto：先看 BOM，再试 UTF-8，都不是时按 GB18030（兼容 GBK / GB2312）解码，
 * 国内字幕站下载的 SRT 很多是 GBK。libass 和 mov_text 都只认 UTF-8，所以统一转码后再交给 FFmpeg
 */
export function decodeSubtitle(buf: Buffer, encoding: SubtitleEncoding = 'auto'): string {
  let text: string;
  if (encoding !== 'auto') {
    text = new TextDecoder(encoding).decode(buf);
  } else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString('utf8');
  } else if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buf.subarray(2));
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buf.subarray(2));
  } else {
    const utf16 = guessUtf16(buf);
    if (utf16) {
      text = new TextDecoder(utf16).decode(buf);
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder('gb18030').decode(buf);
      }
    }
  }
  return normalizeSubtitleText(text);
}

/** 去掉 BOM 和 NUL，换行统一成 \n */
export function normalizeSubtitleText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\0/g, '').replace(/\r\n?/g, '\n');
}

const SRT_TIMING = /\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}/;

/** 按内容判断字幕格式，不看扩展名（URL 下载的文件扩展名不可信） */
export function detectSubtitleFormat(text: string): SubtitleFormat | undefined {
  const head = text.replace(/^﻿/, '').trimStart();
  if (/^\[script info\]/i.test(head)) return /^\[events\]/im.test(text) ? 'ass' : undefined;
  if (/^WEBVTT(?:[ \t\n]|$)/.test(head)) return 'vtt';
  if (SRT_TIMING.test(head)) return 'srt';
  return undefined;
}

export interface AssScriptInfo {
  /** 脚本分辨率的高，FontSize、MarginV 都以它为单位，渲染时按 视频高 / PlayResY 缩放 */
  playResY: number;
  /** 描边、阴影是否随分辨率缩放 */
  scaledBorder: boolean;
}

/**
 * 读 ASS 的 [Script Info]。缺省值和 libass 一致：都没写时 384x288，只写一边时按 4:3 推算
 */
export function assScriptInfo(text: string): AssScriptInfo {
  let playResX = 0;
  let playResY = 0;
  let scaledBorder = false;
  let inInfo = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inInfo = /^\[script info\]$/i.test(line);
      continue;
    }
    if (!inInfo) continue;
    const match = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const lower = key.toLowerCase();
    if (lower === 'playresx') playResX = parseInt(value, 10) || 0;
    else if (lower === 'playresy') playResY = parseInt(value, 10) || 0;
    else if (lower === 'scaledborderandshadow') scaledBorder = /^yes$/i.test(value.trim());
  }
  if (!playResY) {
    if (playResX === 1280) playResY = 1024;
    else if (playResX > 0) playResY = Math.round((playResX * 3) / 4);
    else playResY = 288;
  }
  return { playResY, scaledBorder };
}

/** FFmpeg 把 SRT / WebVTT 转成 ASS 时用的脚本信息（libavcodec/ass.h 的默认值） */
export const FFMPEG_TEXT_SUBTITLE_INFO: AssScriptInfo = { playResY: 288, scaledBorder: true };

// SRT 总有小时位（00:00:01,000），WebVTT 可以省略（00:01.000）
const CUE_TIME = String.raw`(?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3}`;
const CUE_TIMING = new RegExp(String.raw`^(\s*)(${CUE_TIME})(\s*-->\s*)(${CUE_TIME})(.*)$`);
const ASS_TIME = /^\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\s*$/;

function parseCueTime(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function formatCueTime(seconds: number, format: 'srt' | 'vtt'): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${format === 'srt' ? ',' : '.'}${pad(ms % 1000, 3)}`;
}

function formatAssTime(seconds: number): string {
  const cs = Math.round(seconds * 100);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360_000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

/** 按分隔符最多拆成 limit 段，最后一段保留剩下的全部内容（ASS 的 Text 字段里可以有逗号） */
function splitLimit(text: string, limit: number): string[] {
  const parts = text.split(',');
  return parts.length <= limit
    ? parts
    : [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(',')];
}

/** 平移后的区间：结束不晚于 0 的丢弃，跨过 0 的从 0 开始 */
function shiftRange(start: number, end: number, offset: number): [number, number] | undefined {
  const s = Math.max(0, start + offset);
  const e = end + offset;
  return e > s ? [s, e] : undefined;
}

function shiftCues(text: string, format: 'srt' | 'vtt', offset: number) {
  let cues = 0;
  const blocks: string[] = [];
  // SRT / WebVTT 的每条字幕是一个空行分隔的块，块里有一行时间轴；没有时间轴的块（WEBVTT 头、NOTE、STYLE）原样保留
  for (const block of text.split(/\n(?:[ \t]*\n)+/)) {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => CUE_TIMING.test(line));
    if (index < 0) {
      blocks.push(block);
      continue;
    }
    const [, indent, start, arrow, end, settings] = CUE_TIMING.exec(lines[index]) ?? [];
    const range = shiftRange(parseCueTime(start), parseCueTime(end), offset);
    if (!range) continue;
    lines[index] =
      `${indent}${formatCueTime(range[0], format)}${arrow}${formatCueTime(range[1], format)}${settings}`;
    blocks.push(lines.join('\n'));
    cues++;
  }
  return { text: blocks.join('\n\n'), cues };
}

function shiftAss(text: string, offset: number) {
  let cues = 0;
  let inEvents = false;
  // [Events] 的 Format 行决定字段顺序，没有时按标准顺序（Layer, Start, End, …, Text 共 10 个字段）
  let startField = 1;
  let endField = 2;
  let fieldCount = 10;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inEvents = /^\[events\]$/i.test(trimmed);
    } else if (inEvents) {
      const format = /^format\s*:(.*)$/i.exec(trimmed);
      if (format) {
        const names = format[1].split(',').map((n) => n.trim().toLowerCase());
        startField = names.indexOf('start');
        endField = names.indexOf('end');
        fieldCount = names.length;
      }
      const dialogue = /^(dialogue\s*:\s*)(.*)$/i.exec(trimmed);
      if (dialogue && startField >= 0 && endField >= 0) {
        const fields = splitLimit(dialogue[2], fieldCount);
        const start = ASS_TIME.exec(fields[startField] ?? '');
        const end = ASS_TIME.exec(fields[endField] ?? '');
        if (start && end) {
          const toSeconds = (m: RegExpExecArray) => +m[1] * 3600 + +m[2] * 60 + +m[3];
          const range = shiftRange(toSeconds(start), toSeconds(end), offset);
          if (!range) continue;
          fields[startField] = formatAssTime(range[0]);
          fields[endField] = formatAssTime(range[1]);
          out.push(`${dialogue[1]}${fields.join(',')}`);
          cues++;
          continue;
        }
      }
    }
    out.push(line);
  }
  return { text: out.join('\n'), cues };
}

/**
 * 字幕时间轴整体平移 offset 秒，返回平移后的文本和剩下的字幕条数。
 * 不用 FFmpeg 的 -itsoffset：负数平移时 mp4 的 mov_text 会出现负时间戳，mkv 会把整个文件的时间轴往后挪；
 * 直接改文本里的时间最可靠，烧录和封装用同一份。ASS 行内的 \t、\move、\k 都相对行首，不受影响
 */
export function shiftSubtitle(
  text: string,
  format: SubtitleFormat,
  offset: number,
): { text: string; cues: number } {
  return format === 'ass' ? shiftAss(text, offset) : shiftCues(text, format, offset);
}
