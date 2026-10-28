import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { generate } from '../../../helpers/media';

// 音频组测试共用：用 volumedetect 量音量，用 aevalsrc 生成带静音段的音频

/** 文件（或其中一段）的平均音量和峰值（dB） */
export function volumeOf(
  file: string,
  opts: { start?: number; duration?: number } = {},
): { mean: number; max: number } {
  const trim =
    opts.start !== undefined || opts.duration !== undefined
      ? `atrim=start=${opts.start ?? 0}${opts.duration !== undefined ? `:duration=${opts.duration}` : ''},`
      : '';
  const result = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      `${trim}volumedetect`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const parse = (key: string) => {
    const match = new RegExp(`${key}:\\s*(-?[\\d.]+|-inf) dB`).exec(result.stderr);
    if (!match) throw new Error(`volumedetect 没有输出 ${key}: ${result.stderr.slice(-500)}`);
    return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
  };
  return { mean: parse('mean_volume'), max: parse('max_volume') };
}

/** 某个频率附近（窄带通）的平均音量（dB），用来判断变调后的主频、低通是否生效 */
export function bandVolume(
  file: string,
  freq: number,
  range?: { start: number; duration: number },
): number {
  const trim = range ? `atrim=start=${range.start}:duration=${range.duration},` : '';
  const result = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      `${trim}bandpass=f=${freq}:width_type=q:w=8,volumedetect`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(result.stderr);
  if (!match) throw new Error(`volumedetect 没有输出: ${result.stderr.slice(-500)}`);
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

/** 图片某个像素的 RGBA */
export function pixelAt(file: string, x: number, y: number): number[] {
  const result = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-vf',
      `crop=1:1:${x}:${y}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-',
    ],
    { maxBuffer: 1024 },
  );
  if (result.status !== 0) throw new Error(`读取像素失败: ${String(result.stderr)}`);
  return [...result.stdout];
}

/** 用 aevalsrc 表达式生成单声道 wav，如 if(between(t,1,3),0,sin(2*PI*440*t)) */
export function makeExprAudio(
  dir: string,
  name: string,
  expr: string,
  duration: number,
  sampleRate = 44100,
): string {
  const file = path.join(dir, name);
  // 表达式里的逗号是滤镜分隔符，必须加引号
  generate(['-f', 'lavfi', '-i', `aevalsrc='${expr}':d=${duration}:s=${sampleRate}`, file]);
  return file;
}

/** 复制一份没有扩展名的文件，模拟 URL 下载来的输入（文件名不可信） */
export function withoutExtension(file: string, name = 'download-input'): string {
  const dest = path.join(path.dirname(file), name);
  fs.copyFileSync(file, dest);
  return dest;
}

export function assertNear(actual: number, expected: number, tolerance: number, label = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${label} 期望 ${expected} ± ${tolerance}，实际 ${actual}`);
  }
}

/**
 * 画面从 0 开始、音轨晚 offset 秒才开始的 mp4（-itsoffset 混流；MPEG-TS 录像、录屏、重新封装的文件常见）。
 * 音轨内容由 aevalsrc 表达式给出，表达式里的 t 从音轨自身的开头算起
 */
export function makeOffsetVideo(
  dir: string,
  name: string,
  opts: { videoDuration: number; audioExpr: string; audioDuration: number; offset: number },
): string {
  const file = path.join(dir, name);
  generate([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=160x120:rate=25:duration=${opts.videoDuration}`,
    '-itsoffset',
    String(opts.offset),
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${opts.audioExpr}':d=${opts.audioDuration}:s=48000`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file,
  ]);
  return file;
}

/**
 * 用管道写出的 webm（浏览器 MediaRecorder、流式录制的产物）：没有 Duration 元素，ffprobe 拿不到时长。
 * args 是 ffmpeg 的输入和编码参数，不含输出
 */
export function makePipedWebm(dir: string, name: string, args: string[]): string {
  const file = path.join(dir, name);
  const result = spawnSync(
    config.ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', ...args, '-f', 'webm', 'pipe:1'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`生成 ${name} 失败: ${String(result.stderr)}`);
  fs.writeFileSync(file, result.stdout);
  return file;
}
