import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { normalizeRawParams } from '../../../../src/core/params';
import type { AnyOperation } from '../../../../src/operations/types';
import { probeRaw } from '../../../../src/utils/media-probe';
import { generate } from '../../../helpers/media';
import { createTestContext, type TestContext } from '../../../helpers/op-context';

/** 参数合法、执行时失败的场景：断言错误信息并清理上下文 */
export async function runFails(
  op: AnyOperation,
  inputs: Record<string, string[]>,
  raw: Record<string, unknown>,
  expected: RegExp,
  opts: { signal?: AbortSignal } = {},
): Promise<TestContext> {
  const params = op.params.parse(normalizeRawParams(raw));
  const ctx = createTestContext(inputs, opts);
  try {
    await assert.rejects(op.run(ctx, params), (err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), expected);
      return true;
    });
  } finally {
    await ctx.cleanup();
  }
  return ctx;
}

function ffmpeg(args: string[]): Buffer {
  return execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 某一时刻某个区域的灰度像素（每像素 1 字节） */
export function grayArea(file: string, time: number, area: Area): Buffer {
  const out = ffmpeg([
    ...(time > 0 ? ['-ss', String(time)] : []),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=${area.w}:${area.h}:${area.x}:${area.y},format=gray`,
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(out.length, area.w * area.h, `没有读到 ${time}s 的画面`);
  return out;
}

/** 某一时刻某个区域里亮度超过 128 的像素数，用来判断字幕 / 波形画在了哪里 */
export function brightPixels(file: string, time: number, area: Area): number {
  let count = 0;
  for (const v of grayArea(file, time, area)) if (v > 128) count++;
  return count;
}

/** 两块同样大小的灰度画面里亮度相差超过 64 的像素数，用来比较字形是否相同 */
export function differentPixels(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length);
  let count = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 64) count++;
  return count;
}

/**
 * 第一条音轨相邻数据包之间（以及 0 秒到第一个包之间）超过 tolerance 秒的时间戳空洞，
 * 返回 [前一包结束, 后一包开始]。空洞在 mp4 里不会被填成静音，很多播放器会把声音提前、与画面错位
 */
export function audioGaps(file: string, tolerance = 0.002): [number, number][] {
  const out = execFileSync(
    config.ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'packet=pts_time,duration_time',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, `${file} 没有音频数据包`);
  const gaps: [number, number][] = [];
  let prevEnd = 0;
  for (const line of lines) {
    const [pts, duration] = line.split(',').map(Number);
    if (pts - prevEnd > tolerance) gaps.push([prevEnd, pts]);
    prevEnd = pts + duration;
  }
  return gaps;
}

/** silencedetect 找到的静音段（秒）；一直静音到结尾时 end 为 Infinity */
export function silences(
  file: string,
  opts: { noiseDb?: number; minSeconds?: number } = {},
): { start: number; end: number }[] {
  const { noiseDb = -50, minSeconds = 0.005 } = opts;
  const proc = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      `silencedetect=n=${noiseDb}dB:d=${minSeconds}`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(proc.status, 0, proc.stderr.slice(-300));
  const result: { start: number; end: number }[] = [];
  for (const match of proc.stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (match[1] === 'start') result.push({ start: Number(match[2]), end: Infinity });
    else if (result.length) result[result.length - 1].end = Number(match[2]);
  }
  return result;
}

/** 某一时刻某个像素的 RGB */
export function pixelAt(
  file: string,
  time: number,
  x: number,
  y: number,
): [number, number, number] {
  const out = ffmpeg([
    ...(time > 0 ? ['-ss', String(time)] : []),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `format=rgb24,crop=1:1:${x}:${y}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  assert.equal(out.length, 3, `没有读到 ${time}s (${x},${y}) 的像素`);
  return [out[0], out[1], out[2]];
}

export function assertNear(
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance = 40,
): void {
  const ok = actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
  assert.ok(ok, `颜色 ${actual.join(',')} 与期望 ${expected.join(',')} 相差太大`);
}

/** 一段音频的峰值音量（dB），全静音时返回 -Infinity */
export function maxVolume(file: string, start: number, duration: number): number {
  // volumedetect 的结果打在 stderr 的 info 级别
  const proc = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostats',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const match = /max_volume:\s*(-?inf|-?[\d.]+) dB/.exec(proc.stderr);
  assert.ok(match, `volumedetect 没有输出: ${proc.stderr.slice(-300)}`);
  return match[1].endsWith('inf') ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

export interface StreamInfo {
  index: number;
  codec_type?: string;
  codec_name?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
}

export async function streamsOf(file: string): Promise<StreamInfo[]> {
  const raw = await probeRaw(file);
  return (Array.isArray(raw.streams) ? raw.streams : []) as StreamInfo[];
}

/** 把生成的文件改成不可信的扩展名，模拟 URL 下载 */
export function disguise(file: string, ext = '.bin'): string {
  const target = path.join(path.dirname(file), `${path.parse(file).name}-dl${ext}`);
  fs.renameSync(file, target);
  return target;
}

/** 纯黑的 H.264 视频，可选正弦音轨，方便按亮度断言叠加内容的位置 */
export function makeBlackVideo(
  dir: string,
  name: string,
  opts: { size?: string; duration?: number; audio?: boolean } = {},
): string {
  const { size = '320x240', duration = 2, audio = true } = opts;
  const file = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `color=c=black:size=${size}:rate=25:duration=${duration}`];
  if (audio)
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-ac', '2', '-shortest');
  args.push('-f', 'mp4', file);
  generate(args);
  return file;
}
