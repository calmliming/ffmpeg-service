import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../../../../src/config';
import { generate } from '../../../helpers/media';

export interface RampOptions {
  /** 秒，默认 3 */
  duration?: number;
  /** 默认 160x120 */
  size?: string;
  /** 默认 25 */
  rate?: number;
  /** 亮度每秒增加多少（0-255），默认 30 */
  slope?: number;
  /** 声音只在 [0, toneUntil) 秒内有正弦波，之后静音；不传表示没有音轨 */
  toneUntil?: number;
  /** 音轨时长，默认与画面相同 */
  audioDuration?: number;
}

/**
 * 亮度随时间线性增加的视频：画面亮度就是时间戳，倒放、剪切、分割后用 frameLuma 就能判断取到的是哪一时刻的画面
 */
export function makeRampVideo(dir: string, name: string, opts: RampOptions = {}): string {
  const { duration = 3, size = '160x120', rate = 25, slope = 30 } = opts;
  const file = path.join(dir, name);
  const args = [
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${size}:r=${rate}:d=${duration},geq=lum='min(255,T*${slope})':cb=128:cr=128`,
  ];
  if (opts.toneUntil !== undefined) {
    const audioDuration = opts.audioDuration ?? duration;
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${audioDuration},volume=volume='if(lt(t,${opts.toneUntil}),1,0)':eval=frame`,
    );
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25');
  if (opts.toneUntil !== undefined) args.push('-c:a', 'aac', '-ac', '2');
  args.push(file);
  generate(args);
  return file;
}

/** makeRampVideo 在 t 秒时 frameLuma 应得到的值：yuv420p 是有限范围（16-235），转成 gray 时会拉伸 */
export function rampLuma(t: number, slope = 30): number {
  const y = Math.min(255, t * slope);
  return Math.min(255, Math.max(0, ((y - 16) * 255) / 219));
}

/** 某一时刻画面的平均亮度（0-255） */
export function frameLuma(file: string, time: number): number {
  const out = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(time),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1:flags=area',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (out.length < 1) throw new Error(`没有取到 ${time} 秒的画面`);
  return out[0];
}

/**
 * 某一时刻画面里一块区域的平均亮度（0-255）。x / y / w / h 是占画面宽高的比例；
 * 取帧时 ffmpeg 会按旋转信息自动转正，得到的就是播放器显示的画面
 */
export function regionLuma(
  file: string,
  time: number,
  region: { x: number; y: number; w: number; h: number },
): number {
  const { x, y, w, h } = region;
  const out = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(time),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=1:1:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (out.length < 1) throw new Error(`没有取到 ${time} 秒的画面`);
  return out[0];
}

/** 左半白、右半黑的横屏画面（带正弦音轨）；rotation 不为 0 时流复制加上旋转信息，模拟手机竖拍的存法 */
export function makeHalfVideo(
  dir: string,
  name: string,
  opts: { size?: string; duration?: number; rotation?: number } = {},
): string {
  const { size = '320x180', duration = 1, rotation = 0 } = opts;
  const width = Number(size.split('x')[0]);
  const file = path.join(dir, name);
  const plain = rotation ? path.join(dir, `plain_${name}`) : file;
  generate([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${size}:r=25:d=${duration},drawbox=x=0:y=0:w=${width / 2}:h=ih:c=white:t=fill`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${duration}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-shortest',
    plain,
  ]);
  if (rotation) {
    generate(['-display_rotation', String(rotation), '-i', plain, '-c', 'copy', file]);
  }
  return file;
}

/**
 * 黑场 + 静音，在 flashAt 秒处同时出现 0.1 秒白场和 1 kHz 提示音，用来检查音画同步。
 * aevalsrc 逐样本计算，提示音的起点精确到样本
 */
export function makeSyncClip(
  dir: string,
  name: string,
  opts: { duration: number; rate: number; flashAt?: number },
): string {
  const { duration, rate, flashAt = 0.5 } = opts;
  const on = `gte(t,${flashAt})*lt(t,${flashAt + 0.1})`;
  const file = path.join(dir, name);
  generate([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=160x120:r=${rate}:d=${duration},drawbox=c=white:t=fill:enable='${on}'`,
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='if(${on},sin(2*PI*1000*t),0)':s=48000:d=${duration}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    file,
  ]);
  return file;
}

/** 画面由暗变亮的时刻（秒）。按帧序号 / fps 换算时间，只适合恒定帧率、从 0 开始的输出 */
export function flashOnsets(file: string, fps: number): number[] {
  const lumas = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      'scale=1:1:flags=area',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  const onsets: number[] = [];
  for (let i = 0; i < lumas.length; i++) {
    if (lumas[i] > 128 && (i === 0 || lumas[i - 1] <= 128)) onsets.push(i / fps);
  }
  return onsets;
}

/** 声音从静音变成响亮的时刻（秒）：振幅超过满幅 30%，且之前至少静了 gap 秒 */
export function toneOnsets(file: string, gap = 0.2): number[] {
  const pcm = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  const threshold = 0.3 * 32767;
  const onsets: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < pcm.length / 2; i++) {
    const t = i / 48000;
    if (Math.abs(pcm.readInt16LE(i * 2)) > threshold) {
      if (t - lastLoud > gap) onsets.push(t);
      lastLoud = t;
    }
  }
  return onsets;
}

/** 一段时间内声音的平均音量（dB）；完全静音返回 -Infinity。volumedetect 的结果在 stderr 里 */
export function meanVolumeDb(file: string, start: number, duration: number): number {
  const proc = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-i',
      file,
      '-vn',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(proc.stderr);
  if (!match || match[1] === '-inf') return -Infinity;
  return Number(match[1]);
}

/** 用过零次数估算正弦波的频率（Hz），只适合单一音调的测试素材 */
export function toneFrequency(file: string, start = 0.2, duration = 0.5): number {
  const pcm = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  const samples = pcm.length / 2;
  let crossings = 0;
  let prev = pcm.readInt16LE(0);
  for (let i = 1; i < samples; i++) {
    const cur = pcm.readInt16LE(i * 2);
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) crossings++;
    prev = cur;
  }
  return crossings / 2 / (samples / 48000);
}

export const near = (actual: number, expected: number, tolerance: number) =>
  Math.abs(actual - expected) <= tolerance;
