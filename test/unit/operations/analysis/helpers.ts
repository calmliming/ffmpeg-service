import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { normalizeRawParams } from '../../../../src/core/params';
import type { AnyOperation } from '../../../../src/operations/types';
import { generate } from '../../../helpers/media';
import { createTestContext, type TestContext } from '../../../helpers/op-context';
import { makePipedWebm } from '../audio/audio-helpers';

/**
 * 跑一个预期失败的操作，返回错误并清理临时目录（runOperation 失败时拿不到 ctx，没法清理）。
 * 参数先按引擎的方式解析，解析失败直接抛出，说明测试本身写错了
 */
export async function runExpectingError(
  op: AnyOperation,
  inputs: Record<string, string[]>,
  rawParams: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; abortAfterStart?: AbortController } = {},
): Promise<{ error: Error; ctx: TestContext; outputs: string[] }> {
  const parsed = op.params.safeParse(normalizeRawParams(rawParams));
  if (!parsed.success) throw new Error(`测试参数不合法: ${parsed.error.message}`);
  const ctx = createTestContext(inputs, { signal: opts.signal });
  try {
    const running = op.run(ctx, parsed.data);
    opts.abortAfterStart?.abort(new Error('任务已取消'));
    await running;
  } catch (err) {
    const outputs = fs.readdirSync(ctx.outputRoot);
    await ctx.cleanup();
    return { error: err as Error, ctx, outputs };
  }
  await ctx.cleanup();
  throw new Error('操作应当失败，却成功了');
}

/** 按顺序拼接几段 1 秒的纯色 / 测试图案画面（无音轨），用来造场景切换和黑场 */
export function makeSegments(
  dir: string,
  name: string,
  sources: string[],
  opts: { size?: string; rate?: number; audio?: boolean } = {},
): string {
  const { size = '320x240', rate = 25, audio = false } = opts;
  const file = path.join(dir, name);
  const args: string[] = [];
  for (const src of sources) {
    const source = src === 'testsrc2' ? 'testsrc2=' : `color=c=${src}:`;
    args.push('-f', 'lavfi', '-i', `${source}size=${size}:rate=${rate}:duration=1`);
  }
  if (audio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${sources.length}`);
  }
  const labels = sources.map((_, i) => `[${i}:v]`).join('');
  args.push('-filter_complex', `${labels}concat=n=${sources.length}:v=1:a=0[v]`, '-map', '[v]');
  if (audio) args.push('-map', `${sources.length}:a`, '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file);
  generate(args);
  return file;
}

/**
 * 和 makeSegments 一样按顺序拼接 1 秒的画面，但用管道写成 VP9 webm（浏览器 MediaRecorder、流式录制的产物）：
 * 没有 Duration 元素，ffprobe 拿不到时长
 */
export function makePipedSegments(dir: string, name: string, sources: string[]): string {
  const args: string[] = [];
  for (const src of sources) {
    const source = src === 'testsrc2' ? 'testsrc2=' : `color=c=${src}:`;
    args.push('-f', 'lavfi', '-i', `${source}size=160x120:rate=25:duration=1`);
  }
  const labels = sources.map((_, i) => `[${i}:v]`).join('');
  args.push(
    '-filter_complex',
    `${labels}concat=n=${sources.length}:v=1:a=0[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
  );
  return makePipedWebm(dir, name, args);
}

/** 整张图缩成 1 个像素后的平均颜色 [r, g, b, a] */
export function averageColor(file: string): number[] {
  const out = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1:flags=area,format=rgba',
      '-f',
      'rawvideo',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return [...out.subarray(0, 4)];
}

/** 某个像素的颜色 [r, g, b, a] */
export function pixelColor(file: string, x: number, y: number): number[] {
  const out = execFileSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=1:1:${x}:${y},format=rgba`,
      '-f',
      'rawvideo',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return [...out.subarray(0, 4)];
}

/** 两个颜色每个分量都相差不超过 tolerance */
export function closeColor(actual: number[], expected: number[], tolerance = 12): boolean {
  return expected.every((v, i) => Math.abs(actual[i] - v) <= tolerance);
}

/**
 * 在 JPEG 的 SOI 之后插入只含 Orientation 一个标签的 EXIF（APP1）段，模拟手机竖拍照片。
 * orientation 6 = 需要顺时针转 90 度显示
 */
export function addExifOrientation(src: string, dest: string, orientation: number): string {
  const data = fs.readFileSync(src);
  // TIFF 头（小端）+ IFD0：1 个条目 0x0112 SHORT 1 个值，下一个 IFD 偏移 0
  const tiff = Buffer.from([
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), length, body]);
  fs.writeFileSync(dest, Buffer.concat([data.subarray(0, 2), app1, data.subarray(2)]));
  return dest;
}
