import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { config } from '../../../../src/config';
import { normalizeRawParams } from '../../../../src/core/params';
import type { AnyOperation } from '../../../../src/operations/types';
import { probeMedia } from '../../../../src/utils/media-probe';
import { generate } from '../../../helpers/media';
import { createTestContext, type TestContext } from '../../../helpers/op-context';

/** 参数合法、执行时失败的场景：断言错误信息，并清理上下文 */
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
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, expected);
      return true;
    });
  } finally {
    await ctx.cleanup();
  }
  return ctx;
}

/** 读取某一时刻某个像素的 RGB，用来断言水印位置、出现时间；图片传 time=0 */
export function pixelAt(
  file: string,
  time: number,
  x: number,
  y: number,
): [number, number, number] {
  const out = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      // 单张图片加 -ss 0 反而一帧都读不到
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
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(out.length, 3, `没有读到 ${time}s (${x},${y}) 的像素`);
  return [out[0], out[1], out[2]];
}

/** 图片或视频的画面尺寸 */
export async function dimensions(file: string): Promise<{ width: number; height: number }> {
  const info = await probeMedia(file);
  assert.ok(info.video, `${file} 没有画面`);
  return { width: info.video.width, height: info.video.height };
}

export async function codecOf(file: string): Promise<string> {
  const info = await probeMedia(file);
  assert.ok(info.video, `${file} 没有画面`);
  return info.video.codec;
}

export interface RampOptions {
  rate: number;
  duration: number;
  /** 每帧亮度（Y）增加多少，从 16 开始 */
  perFrame: number;
  /** 固定关键帧间隔（帧数），不传由编码器决定 */
  gop?: number;
  /** 容器格式，如 mpegts；不传按扩展名 */
  format?: string;
}

/**
 * 亮度随帧号线性递增的灰色小视频（无损 H.264），配合 frameTable / matchFrame 按像素反查截到的是第几帧
 */
export function makeRamp(file: string, opts: RampOptions): string {
  const args = [
    '-f',
    'lavfi',
    '-i',
    `color=c=black:size=64x48:rate=${opts.rate}:duration=${opts.duration},format=gray,geq=lum='16+N*${opts.perFrame}'`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-qp',
    '0',
    '-pix_fmt',
    'yuv420p',
  ];
  if (opts.gop) {
    args.push('-g', String(opts.gop), '-keyint_min', String(opts.gop), '-sc_threshold', '0');
  }
  if (opts.format) args.push('-f', opts.format);
  args.push(file);
  generate(args);
  return file;
}

/** 从头逐帧解码，返回每一帧 (x,y) 处的 R 值，下标就是帧号 */
export function frameTable(file: string, x = 8, y = 8): number[] {
  const out = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:V:0',
      '-vf',
      `format=rgb24,crop=1:1:${x}:${y}`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  const values: number[] = [];
  for (let i = 0; i + 2 < out.length; i += 3) values.push(out[i]);
  return values;
}

/** 图片 (x,y) 处的颜色与第几帧最接近 */
export function matchFrame(image: string, table: number[], x = 8, y = 8): number {
  const [r] = pixelAt(image, 0, x, y);
  let best = 0;
  table.forEach((value, i) => {
    if (Math.abs(value - r) < Math.abs(table[best] - r)) best = i;
  });
  return best;
}

/** 时间点处或之后的第一帧的帧号（恒定帧率） */
export function frameAtOrAfter(time: number, rate: number): number {
  return Math.max(0, Math.ceil(time * rate - 1e-6));
}

/** 颜色大致为某个值（编码有损，留出容差） */
export function assertColor(
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance = 40,
): void {
  const ok = actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
  assert.ok(ok, `颜色 ${actual.join(',')} 与期望 ${expected.join(',')} 相差过大`);
}
