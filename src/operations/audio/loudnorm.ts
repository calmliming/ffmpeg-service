import { numberParam } from '../../schemas/coerce';
import type { OperationContext } from '../types';
import { ZERO_PTS, decodedDuration, num, rethrowWith } from './format';

// EBU R128 两遍响度标准化，audio.normalize 和 video.normalize-audio 共用

export interface LoudnessTarget {
  /** 目标综合响度 LUFS */
  i: number;
  /** 真峰值上限 dBTP */
  tp: number;
  /** 目标响度范围 LU */
  lra: number;
}

export interface LoudnessStats {
  i: number;
  tp: number;
  lra: number;
  thresh: number;
}

export interface LoudnormReport {
  input: LoudnessStats;
  output: LoudnessStats;
  targetOffset: number;
  /** linear 表示整体线性增益（不改变动态），dynamic 表示 loudnorm 退回了动态压缩 */
  normalizationType: string;
}

export const loudnessFields = {
  targetLufs: numberParam('targetLufs', { min: -70, max: -5 }).default(-14).meta({
    description:
      '目标综合响度（LUFS，-70 到 -5），默认 -14（主流流媒体平台）；广播电视常用 -23（EBU R128）或 -24（ATSC A/85），播客常用 -16',
  }),
  truePeak: numberParam('truePeak', { min: -9, max: 0 })
    .default(-1)
    .meta({ description: '真峰值上限（dBTP，-9 到 0），默认 -1' }),
  lra: numberParam('lra', { min: 1, max: 50 })
    .default(11)
    .meta({ description: '目标响度范围（LU，1 到 50），默认 11' }),
};

export function targetFrom(params: { targetLufs: number; truePeak: number; lra: number }) {
  return { i: params.targetLufs, tp: params.truePeak, lra: params.lra };
}

function parseLevel(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return Number.NaN;
  const s = String(value).trim().toLowerCase();
  if (s === '-inf') return Number.NEGATIVE_INFINITY;
  if (s === 'inf' || s === '+inf') return Number.POSITIVE_INFINITY;
  return Number(s);
}

/** 从 stderr 里取 loudnorm 打印的最后一个 JSON 块 */
export function parseLoudnormJson(stderr: string): LoudnormReport {
  const blocks = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g);
  if (!blocks) throw new Error('没有拿到 loudnorm 的测量结果');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>;
  } catch {
    throw new Error('loudnorm 的测量结果格式无法解析');
  }
  const stats = (prefix: string): LoudnessStats => ({
    i: parseLevel(json[`${prefix}_i`]),
    tp: parseLevel(json[`${prefix}_tp`]),
    lra: parseLevel(json[`${prefix}_lra`]),
    thresh: parseLevel(json[`${prefix}_thresh`]),
  });
  return {
    input: stats('input'),
    output: stats('output'),
    targetOffset: parseLevel(json.target_offset),
    normalizationType: typeof json.normalization_type === 'string' ? json.normalization_type : '',
  };
}

function targetOptions(t: LoudnessTarget): string {
  return `I=${num(t.i, 2)}:TP=${num(t.tp, 2)}:LRA=${num(t.lra, 2)}`;
}

/** 第一遍：只测量 */
export function measureFilter(t: LoudnessTarget): string {
  return `loudnorm=${targetOptions(t)}:print_format=json`;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * 第二遍：带上测量值做线性标准化。测量值来自 ffmpeg 输出，解析成数字并夹到 loudnorm 允许的范围后再拼进滤镜，
 * 不会把原始文本带进滤镜参数
 */
export function applyFilter(t: LoudnessTarget, measured: LoudnormReport): string {
  const m = measured.input;
  const parts = [
    `measured_I=${num(clamp(m.i, -99, 0), 2)}`,
    `measured_TP=${num(clamp(m.tp, -99, 99), 2)}`,
    // 响度恒定的素材（纯音、重度压缩的音乐、很短的片段）测出 LRA=0，FFmpeg 把 0 当成没传而退回动态模式，至少给 0.01
    `measured_LRA=${num(clamp(m.lra, 0.01, 99), 2)}`,
    `measured_thresh=${num(clamp(m.thresh, -99, 0), 2)}`,
    `offset=${num(clamp(Number.isFinite(measured.targetOffset) ? measured.targetOffset : 0, -99, 99), 2)}`,
  ];
  return `loudnorm=${targetOptions(t)}:${parts.join(':')}:linear=true:print_format=json`;
}

/** EBU R128 的综合响度按 400 毫秒的测量块计算，更短的音频一个块都凑不满，测出来总是 -inf */
export const MIN_R128_SECONDS = 0.4;

/**
 * 测量结果是否能用来做标准化：静音或接近静音的输入响度是 -inf，算出来的增益没有意义。
 * length 是测量时实际解码出的音频长度（秒）：太短的音效也测出 -inf，要先排除，免得报成「几乎是静音」
 */
export function assertMeasurable(report: LoudnormReport, length?: number): void {
  if (length !== undefined && length < MIN_R128_SECONDS) {
    throw new Error(
      `音频只有 ${num(length, 3)} 秒，短于 ${MIN_R128_SECONDS} 秒，无法按 EBU R128 测量综合响度，不能做响度标准化`,
    );
  }
  const { i, tp, lra, thresh } = report.input;
  if (!Number.isFinite(i) || i <= -70 || !Number.isFinite(tp)) {
    const shown = Number.isFinite(i) ? `${num(i, 2)} LUFS` : '-inf';
    throw new Error(`输入音频几乎是静音（综合响度 ${shown}），无法做响度标准化`);
  }
  if (!Number.isFinite(lra) || !Number.isFinite(thresh)) {
    throw new Error('loudnorm 的测量结果不完整，无法做响度标准化');
  }
}

/** 第一遍测量，只解码第一条音轨，输出丢弃 */
export async function measureLoudness(
  ctx: OperationContext,
  file: string,
  target: LoudnessTarget,
  opts: { duration?: number; range: [number, number] },
): Promise<LoudnormReport> {
  // 时间戳归零后统计里的 time= 就是音轨自身的长度（音轨晚于文件开头时不带偏移），用来判断是否太短
  const filter = `${ZERO_PTS},${measureFilter(target)}`;
  const { stderr } = await ctx
    .ffmpeg(['-i', file, '-map', '0:a:0', '-af', filter, '-f', 'null', '-'], {
      duration: opts.duration,
      range: opts.range,
      logLevel: 'info',
      captureStderr: true,
    })
    .catch(rethrowWith(ctx, '响度测量失败'));
  const report = parseLoudnormJson(stderr);
  assertMeasurable(report, decodedDuration(stderr));
  return report;
}

/** 返回给客户端的结构化结果 */
export function reportData(
  target: LoudnessTarget,
  measured: LoudnormReport,
  final?: LoudnormReport,
) {
  const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  const stats = (s: LoudnessStats) => ({
    i: round(s.i),
    tp: round(s.tp),
    lra: round(s.lra),
    thresh: round(s.thresh),
  });
  return {
    target: { i: target.i, tp: target.tp, lra: target.lra },
    input: stats(measured.input),
    output: stats((final ?? measured).output),
    normalizationType: final?.normalizationType || measured.normalizationType,
  };
}
