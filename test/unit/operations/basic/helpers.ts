import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { normalizeRawParams } from '../../../../src/core/params';
import type { AnyOperation } from '../../../../src/operations/types';
import { probeRaw } from '../../../../src/utils/media-probe';
import { generate } from '../../../helpers/media';
import { createTestContext } from '../../../helpers/op-context';

export interface StreamFacts {
  type: string;
  codec: string;
  tag: string;
  width: number;
  height: number;
  rate: string;
  sampleRate: number;
  channels: number;
  bitRate: number;
}

export interface FileFacts {
  formatName: string;
  duration: number;
  tags: Record<string, string>;
  streams: StreamFacts[];
  video?: StreamFacts;
  audio?: StreamFacts;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  disposition?: { attached_pic?: number };
}

/** 比 probeMedia 多拿一些断言要用的字段：封装格式、codec tag、码率、全局标签 */
export async function facts(file: string): Promise<FileFacts> {
  const raw = (await probeRaw(file)) as {
    streams?: RawStream[];
    format?: { format_name?: string; duration?: string; tags?: Record<string, string> };
  };
  const streams = (raw.streams ?? [])
    .filter((s) => !s.disposition?.attached_pic)
    .map((s) => ({
      type: s.codec_type ?? '',
      codec: s.codec_name ?? '',
      tag: s.codec_tag_string ?? '',
      width: s.width ?? 0,
      height: s.height ?? 0,
      rate: s.r_frame_rate ?? '',
      sampleRate: Number(s.sample_rate) || 0,
      channels: s.channels ?? 0,
      bitRate: Number(s.bit_rate) || 0,
    }));
  return {
    formatName: raw.format?.format_name ?? '',
    duration: Number(raw.format?.duration) || 0,
    tags: raw.format?.tags ?? {},
    streams,
    video: streams.find((s) => s.type === 'video'),
    audio: streams.find((s) => s.type === 'audio'),
  };
}

export function assertNear(actual: number, expected: number, tolerance: number, label = '时长') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} ${actual} 与预期 ${expected} 相差超过 ${tolerance}`,
  );
}

/** 参数合法、但执行阶段应当失败（探测后才知道的问题），断言错误信息并清理临时目录 */
export async function expectRunError(
  op: AnyOperation,
  inputs: Record<string, string[]>,
  rawParams: Record<string, unknown>,
  expected: RegExp,
): Promise<void> {
  const parsed = op.params.parse(normalizeRawParams(rawParams));
  const provided = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.length]));
  assert.equal(op.check?.(parsed, provided), undefined, '参数校验应当通过');
  const ctx = createTestContext(inputs);
  try {
    await assert.rejects(op.run(ctx, parsed), expected);
  } finally {
    await ctx.cleanup();
  }
}

/**
 * 10 秒 64x48、25 fps 的「亮度随时间线性变化」视频（亮度 16 + 20·t，每秒约差 23 级灰度）加正弦音轨，
 * 每 2 秒一个关键帧、关闭场景切换。看第一帧的亮度就知道片段从哪个时间点开始，用来验证跳转是否精确。
 * codecArgs 决定编码和封装，如 ['-c:v', 'libx264', …, '-f', 'mpegts']
 */
export function makeRamp(dir: string, name: string, codecArgs: string[]): string {
  const file = path.join(dir, name);
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=64x48:r=25:d=10,geq=lum=16+T*20:cb=128:cr=128',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=10',
    '-shortest',
    '-g',
    '50',
    ...codecArgs,
    file,
  ]);
  return file;
}

/** H.264（带 B 帧）+ AAC 的 MPEG-TS 参数，给 makeRamp 用 */
export const TS_H264 = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-keyint_min',
  '50',
  '-sc_threshold',
  '0',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-f',
  'mpegts',
];

/** 解码一帧并缩成 1 像素的灰度值（0-255）。at 给出时从头解码到该时间（输出端跳转，一定准确）作为参照 */
export function frameLuma(file: string, at?: number): number {
  const seek = at === undefined ? [] : ['-ss', String(at)];
  const out = execFileSync(
    config.ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      file,
      ...seek,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(out.length, 1, `${file} 解不出画面`);
  return out[0];
}

/** 第一路视频实际解出的帧数（没有视频流时为 0） */
export function countFrames(file: string): number {
  const out = execFileSync(
    config.ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  );
  return Number.parseInt(out.trim(), 10) || 0;
}

/** 产物的扩展名（不带点） */
export const extOf = (file: string) => path.extname(file).slice(1);

/** 产物必须落在测试上下文的输出目录里 */
export function assertInside(root: string, file: string) {
  const rel = path.relative(root, file);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `${file} 不在 ${root} 里`);
  assert.ok(fs.statSync(file).size > 0, `${file} 是空文件`);
}
