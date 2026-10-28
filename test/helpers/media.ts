import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config';

// 用 ffmpeg 现场生成小素材跑真实命令，机器上没有 ffmpeg 时整组跳过：test('…', { skip: ffmpegSkip }, …)
// 很多测试文件并行启动时 Windows 偶尔 spawn 失败（EAGAIN / ENOMEM），整个文件会悄悄全部跳过，所以多试几次；
// CI 设 FFMPEG_REQUIRED=1 时找不到 ffmpeg 直接报错，不跳过
function ffmpegAvailable(): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      execFileSync(config.ffmpegPath, ['-version'], { stdio: 'ignore' });
      execFileSync(config.ffprobePath, ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      // 重试
    }
  }
  if (process.env.FFMPEG_REQUIRED === '1') {
    throw new Error(`FFMPEG_REQUIRED=1 但无法运行 ${config.ffmpegPath} / ${config.ffprobePath}`);
  }
  return false;
}
export const ffmpegSkip: false | string = ffmpegAvailable() ? false : 'ffmpeg 不可用';

export function makeTempDir(prefix = 'ffsvc-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function generate(args: string[]): void {
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args, '-y'], {
    stdio: 'pipe',
  });
}

export interface VideoOptions {
  /** 默认 320x240 */
  size?: string;
  /** 默认 25 */
  rate?: number;
  /** 秒，默认 2 */
  duration?: number;
  /** 默认 true */
  audio?: boolean;
  /** 正弦波频率，默认 440 */
  freq?: number;
}

/** 生成带测试画面（testsrc2）和可选正弦音轨的 H.264 / AAC mp4 */
export function makeVideo(dir: string, name: string, opts: VideoOptions = {}): string {
  const { size = '320x240', rate = 25, duration = 2, audio = true, freq = 440 } = opts;
  const file = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${duration}`];
  if (audio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${duration}`);
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-ac', '2', '-shortest');
  args.push(file);
  generate(args);
  return file;
}

export interface AudioOptions {
  /** 秒，默认 2 */
  duration?: number;
  /** 默认 440 */
  freq?: number;
  /** 默认 44100 */
  sampleRate?: number;
  /** 默认 2 */
  channels?: number;
  /** 前后各补多少秒静音，用于测试静音检测 / 去静音，默认 0 */
  silencePad?: number;
  /** 音量倍数，默认 1；测试响度标准化时可以调小 */
  volume?: number;
}

/** 生成正弦波音频，编码由扩展名决定（.wav / .mp3 / .m4a / .flac …） */
export function makeAudio(dir: string, name: string, opts: AudioOptions = {}): string {
  const {
    duration = 2,
    freq = 440,
    sampleRate = 44100,
    channels = 2,
    silencePad = 0,
    volume = 1,
  } = opts;
  const file = path.join(dir, name);
  const filters = [`volume=${volume}`];
  if (silencePad > 0) {
    const delayMs = Math.round(silencePad * 1000);
    filters.push(`adelay=${delayMs}:all=1`, `apad=pad_dur=${silencePad}`);
  }
  generate([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:sample_rate=${sampleRate}:duration=${duration}`,
    '-af',
    filters.join(','),
    '-ac',
    String(channels),
    file,
  ]);
  return file;
}

/** 生成纯色或测试图案图片，格式由扩展名决定（.png / .jpg / .webp） */
export function makeImage(
  dir: string,
  name: string,
  opts: { size?: string; color?: string } = {},
): string {
  const { size = '320x240', color } = opts;
  const file = path.join(dir, name);
  const source = color ? `color=c=${color}:size=${size}` : `testsrc2=size=${size}`;
  generate(['-f', 'lavfi', '-i', source, '-frames:v', '1', file]);
  return file;
}

/** 写一个 SRT 字幕文件，默认两条字幕覆盖 0-2 秒，第二条是中文 */
export function makeSrt(
  dir: string,
  name: string,
  cues: { start: string; end: string; text: string }[] = [
    { start: '00:00:00,000', end: '00:00:01,000', text: 'Hello subtitle' },
    { start: '00:00:01,000', end: '00:00:02,000', text: '中文字幕测试' },
  ],
): string {
  const file = path.join(dir, name);
  const body = cues.map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n`).join('\n');
  fs.writeFileSync(file, body);
  return file;
}
