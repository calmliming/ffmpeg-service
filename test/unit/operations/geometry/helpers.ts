import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../../../../src/config';
import { normalizeRawParams } from '../../../../src/core/params';
import type { AnyOperation } from '../../../../src/operations/types';
import { probeRaw } from '../../../../src/utils/media-probe';
import { generate } from '../../../helpers/media';
import { createTestContext } from '../../../helpers/op-context';

export type Rgb = [number, number, number];

/**
 * 参数合法、执行时应当失败（探测后才知道的问题）。和 runOperation 一样解析参数，
 * 但自己持有上下文，失败后也能清理临时目录
 */
export async function expectRunError(
  op: AnyOperation,
  inputs: Record<string, string[]>,
  rawParams: Record<string, unknown>,
  pattern: RegExp,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const parsed = op.params.safeParse(normalizeRawParams(rawParams));
  assert.ok(parsed.success, `参数应当合法: ${JSON.stringify(rawParams)}`);
  const provided = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.length]));
  assert.equal(op.check?.(parsed.data, provided), undefined);
  const ctx = createTestContext(inputs, opts);
  try {
    await assert.rejects(op.run(ctx, parsed.data), pattern);
  } finally {
    await ctx.cleanup();
  }
}

/** 解码 t 秒处的一帧，取 (x, y) 处的 RGB（先按显示矩阵摆正，和播放器看到的一致） */
export function pixelAt(file: string, t: number, x: number, y: number): Rgb {
  const buf = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `format=rgb24,crop=1:1:${x}:${y}`,
      '-f',
      'rawvideo',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return [buf[0], buf[1], buf[2]];
}

const NAMED: Record<string, Rgb> = {
  red: [255, 0, 0],
  lime: [0, 255, 0],
  blue: [0, 0, 255],
  white: [255, 255, 255],
  black: [0, 0, 0],
  yellow: [255, 255, 0],
};

/** 颜色是否接近（H.264 有损压缩，留 60 的容差） */
export function near(actual: Rgb, expected: keyof typeof NAMED | Rgb, tolerance = 60): boolean {
  const target = typeof expected === 'string' ? NAMED[expected] : expected;
  return actual.every((v, i) => Math.abs(v - target[i]) <= tolerance);
}

/**
 * 四个色块拼成的测试画面：左上红、右上绿（lime）、左下蓝、右下白。
 * 旋转、翻转后看四个角的颜色就能判断方向
 */
export function makeQuadVideo(
  dir: string,
  name: string,
  opts: { size?: [number, number]; duration?: number; audio?: boolean } = {},
): string {
  const [w, h] = opts.size ?? [320, 240];
  const d = opts.duration ?? 1;
  const file = path.join(dir, name);
  const args: string[] = [];
  for (const color of ['red', 'lime', 'blue', 'white']) {
    args.push('-f', 'lavfi', '-i', `color=${color}:s=${w / 2}x${h / 2}:d=${d}:r=25`);
  }
  if (opts.audio)
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${d}`);
  args.push(
    '-filter_complex',
    '[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
  );
  if (opts.audio) args.push('-map', '4:a', '-c:a', 'aac', '-shortest');
  args.push(file);
  generate(args);
  return file;
}

/** 纯色视频，可选音轨 */
export function makeColorVideo(
  dir: string,
  name: string,
  opts: { color: string; size?: string; duration?: number; audio?: boolean; rate?: number },
): string {
  const { color, size = '160x120', duration = 1, audio = false, rate = 25 } = opts;
  const file = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `color=${color}:s=${size}:d=${duration}:r=${rate}`];
  if (audio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${duration}`);
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  generate(args);
  return file;
}

/** VP9 + Opus 的 webm（浏览器录屏常见格式），audio=false 时无音轨 */
export function makeWebm(dir: string, name: string, opts: { audio?: boolean } = {}): string {
  const file = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=1'];
  if (opts.audio !== false) {
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1');
  }
  args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k');
  if (opts.audio !== false) args.push('-c:a', 'libopus', '-shortest');
  args.push(file);
  generate(args);
  return file;
}

/** 不重新编码，给视频写入显示矩阵（逆时针角度），模拟手机竖拍的视频 */
export function withDisplayRotation(src: string, dest: string, ccwDegrees: number): string {
  generate(['-display_rotation', String(ccwDegrees), '-i', src, '-c', 'copy', dest]);
  return dest;
}

/** 第一路画面流上显示矩阵的旋转角度，没有时为 undefined */
export async function displayRotation(file: string): Promise<number | undefined> {
  const raw = (await probeRaw(file)) as {
    streams?: {
      codec_type?: string;
      side_data_list?: { side_data_type?: string; rotation?: number }[];
    }[];
  };
  const video = raw.streams?.find((s) => s.codec_type === 'video');
  return video?.side_data_list?.find((d) => d.side_data_type === 'Display Matrix')?.rotation;
}

/** 渲染一帧为 PNG，用于人工查看 */
export function snapshot(file: string, t: number, png: string): string {
  generate(['-ss', String(t), '-i', file, '-frames:v', '1', png]);
  return png;
}

export function frameRate(file: string): string {
  return execFileSync(
    config.ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=r_frame_rate',
      '-of',
      'default=nw=1:nk=1',
      file,
    ],
    { encoding: 'utf8' },
  ).trim();
}
