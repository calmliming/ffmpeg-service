import fs from 'fs';
import { z } from 'zod';
import { bitrateParam, booleanParam, enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  MAX_LONG_SIDE,
  VIDEO_INPUT,
  assertFrameSize,
  evenCropFilter,
  inspectVideo,
  num,
} from './shared';

type Codec = 'h264' | 'h265' | 'vp9' | 'av1';
type Quality = 'low' | 'medium' | 'high';
type Speed = 'fast' | 'medium' | 'slow';
type Container = 'mp4' | 'webm';

// 各编码器的 CRF 取值不在同一个尺度上，按主观画质大致对齐
const CRF: Record<Codec, Record<Quality, number>> = {
  h264: { high: 21, medium: 25, low: 30 },
  h265: { high: 24, medium: 28, low: 32 },
  vp9: { high: 30, medium: 35, low: 40 },
  av1: { high: 28, medium: 35, low: 42 },
};
const X26X_PRESET: Record<Speed, string> = { fast: 'veryfast', medium: 'medium', slow: 'slow' };
const VP9_CPU_USED: Record<Speed, number> = { fast: 5, medium: 4, slow: 2 };
const SVT_PRESET: Record<Speed, number> = { fast: 10, medium: 8, slow: 6 };

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_AUDIO_BPS = 128_000;
/** 低于这个码率画面基本不可看，直接拒绝并提示调整参数 */
const MIN_VIDEO_BPS = 20_000;
/** 两遍编码的码率留 3% 余量，短视频的首个关键帧容易让实际大小偏大 */
const RATE_SAFETY = 0.97;
const PASS_LOG = 'passlog';
const X265_STATS = 'x265_stats.log';

/** 128k / 2M / 800000 → bps；小于 1000 的纯数字按 kbps 理解（128 当成 128k，128 bps 没有意义） */
export function parseBitrate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value.trim());
  if (!match) return Number.NaN;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'k') return Math.round(n * 1000);
  if (unit === 'm') return Math.round(n * 1_000_000);
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

const audioBitrateParam = bitrateParam('audioBitrate').transform((value, ctx) => {
  const bps = parseBitrate(value);
  if (!(bps >= 16_000 && bps <= 512_000)) {
    ctx.addIssue('audioBitrate 必须在 16k 到 512k 之间');
    return z.NEVER;
  }
  return bps;
});

const params = z.object({
  targetSizeMB: numberParam('targetSizeMB', { min: 0.01, max: 100000 }).optional().meta({
    description:
      '目标文件大小（MB，按 1024×1024 字节计）。设置后用两遍编码精确控制码率，不能和 quality 同时使用',
  }),
  quality: enumParam('quality', ['low', 'medium', 'high'] as const)
    .optional()
    .meta({
      description:
        '画质档位（CRF）：low 体积最小、medium（默认）、high 画质最好；不设 targetSizeMB 时生效',
    }),
  codec: enumParam('codec', ['h264', 'h265', 'vp9', 'av1'] as const)
    .default('h264')
    .meta({
      description:
        '视频编码：h264（默认，兼容性最好）、h265（同画质约小 40%）、vp9、av1（压缩率最高、编码最慢）',
    }),
  format: enumParam('format', ['mp4', 'webm'] as const)
    .optional()
    .meta({ description: '输出容器：mp4 或 webm。默认 vp9 输出 webm，其余输出 mp4' }),
  maxWidth: numberParam('maxWidth', { min: 64, max: MAX_LONG_SIDE, int: true })
    .optional()
    .meta({ description: '最大宽度（64-7680），超过时按比例缩小，不会放大' }),
  maxHeight: numberParam('maxHeight', { min: 64, max: MAX_LONG_SIDE, int: true })
    .optional()
    .meta({ description: '最大高度（64-7680），超过时按比例缩小，不会放大' }),
  maxFps: numberParam('maxFps', { min: 1, max: 120 })
    .optional()
    .meta({ description: '最大帧率（1-120），原片帧率更高时降到这个值' }),
  audioBitrate: audioBitrateParam.optional().meta({
    description: '音频码率（16k-512k），如 96k、128k。默认 128k，原音轨码率更低时沿用原码率',
  }),
  removeAudio: booleanParam('removeAudio')
    .default(false)
    .meta({ description: '去掉音轨，把全部体积留给画面，默认 false' }),
  speed: enumParam('speed', ['fast', 'medium', 'slow'] as const)
    .default('medium')
    .meta({
      description: '编码速度：fast 最快、medium（默认）、slow 同样体积下画质更好但更慢',
    }),
});

type CompressParams = z.output<typeof params>;

export function outputContainer(p: Pick<CompressParams, 'codec' | 'format'>): Container {
  return p.format ?? (p.codec === 'vp9' ? 'webm' : 'mp4');
}

/** 按 maxWidth / maxHeight 等比缩小，只缩不放，结果为偶数 */
export function fitSize(
  width: number,
  height: number,
  maxWidth?: number,
  maxHeight?: number,
): { width: number; height: number; scaled: boolean } {
  const factor = Math.min(1, maxWidth ? maxWidth / width : 1, maxHeight ? maxHeight / height : 1);
  if (factor >= 1) return { width, height, scaled: false };
  let w = Math.max(2, Math.round((width * factor) / 2) * 2);
  let h = Math.max(2, Math.round((height * factor) / 2) * 2);
  if (maxWidth) w = Math.min(w, Math.floor(maxWidth / 2) * 2);
  if (maxHeight) h = Math.min(h, Math.floor(maxHeight / 2) * 2);
  return { width: w, height: h, scaled: true };
}

type RateControl = { crf: number } | { bitrate: number; pass: 1 | 2 };

export function videoCodecArgs(codec: Codec, speed: Speed, rc: RateControl): string[] {
  const rate = 'crf' in rc ? ['-crf', String(rc.crf)] : ['-b:v', String(rc.bitrate)];
  const pass = 'pass' in rc ? rc.pass : undefined;
  const passArgs = pass ? ['-pass', String(pass), '-passlogfile', PASS_LOG] : [];
  switch (codec) {
    case 'h264':
      return ['-c:v', 'libx264', '-preset', X26X_PRESET[speed], ...rate, ...passArgs];
    case 'h265': {
      // libx265 的两遍参数走 x265-params；log-level=error 关掉它直接写 stderr 的统计信息
      const x265 = pass ? `log-level=error:pass=${pass}:stats=${X265_STATS}` : 'log-level=error';
      return [
        '-c:v',
        'libx265',
        '-preset',
        X26X_PRESET[speed],
        ...rate,
        '-x265-params',
        x265,
        // FFmpeg 默认写 hev1，Safari / QuickTime / iOS 只播放 hvc1；h265 只会进 mp4，总是加上
        '-tag:v',
        'hvc1',
      ];
    }
    case 'vp9':
      return [
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'good',
        '-cpu-used',
        String(VP9_CPU_USED[speed]),
        '-row-mt',
        '1',
        // libvpx 的 CRF 模式必须同时给 -b:v 0，否则会被当成受限码率
        ...('crf' in rc ? [...rate, '-b:v', '0'] : rate),
        ...passArgs,
      ];
    case 'av1':
      return ['-c:v', 'libsvtav1', '-preset', String(SVT_PRESET[speed]), ...rate, ...passArgs];
  }
}

export const compress = defineOperation({
  name: 'video.compress',
  route: '/api/video/compress',
  title: '视频压缩',
  description:
    '按目标文件大小（两遍编码）或画质档位压缩视频，可同时限制分辨率和帧率、切换 H.265 / VP9 / AV1 编码。',
  inputs: VIDEO_INPUT,
  params,
  chainable: true,
  example: [
    '# 压到 20 MB 以内',
    'curl -X POST http://localhost:9527/api/video/compress \\',
    '  -F "file=@input.mp4" -F "targetSizeMB=20"',
    '',
    '# 720p + H.265 + 低画质档位',
    'curl -X POST http://localhost:9527/api/video/compress \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","quality":"low","codec":"h265","maxWidth":1280,"maxHeight":1280}\'',
  ].join('\n'),
  notes: [
    'targetSizeMB 和 quality 二选一，都不传时按 quality=medium 压缩。MB 按 1024×1024 字节计。',
    'targetSizeMB：视频码率 =（目标大小 − 音频 − 封装开销）÷ 时长，两遍编码；结果超出目标时自动降码率重新做一次两遍编码，保留两次中更小的结果，通常落在目标的 90%-100%。目标大于原文件时码率不超过原文件的平均码率，不会把文件变大。',
    'quality 模式不保证比原文件小：原片码率已经很低时输出可能更大，这时请改用 targetSizeMB。',
    '容器：h264 / h265 / av1 默认 mp4，vp9 默认 webm，也可以用 format 指定；webm 只支持 vp9 和 av1。h265 在 mp4 里打 hvc1 标签，苹果设备可以直接播放。',
    '音频：mp4 用 AAC、webm 用 Opus，只保留第一条音轨；默认 128k，原音轨码率更低时沿用原码率。removeAudio=true 去掉音轨。',
    '结果 data 包含 originalSize、outputSize（字节）、ratio（输出 / 原始），以及实际使用的编码、分辨率和码率。',
  ],
  check(p) {
    if (p.targetSizeMB !== undefined && p.quality !== undefined) {
      return 'targetSizeMB 和 quality 只能二选一：按目标大小压缩时码率由大小决定';
    }
    if (outputContainer(p) === 'webm' && (p.codec === 'h264' || p.codec === 'h265')) {
      return 'webm 只支持 vp9 和 av1 编码，h264 / h265 请用 mp4';
    }
    return undefined;
  },
  async run(ctx, p) {
    const input = await inspectVideo(ctx, ctx.inputs.file[0]);
    assertFrameSize(input);
    const originalSize = (await fs.promises.stat(input.file)).size;
    const container = outputContainer(p);
    const duration = input.duration;

    const filters: string[] = [];
    const size = fitSize(input.width, input.height, p.maxWidth, p.maxHeight);
    let { width, height } = size;
    if (size.scaled) {
      filters.push(`scale=${width}:${height}:flags=lanczos`);
    } else {
      const even = evenCropFilter(width, height);
      if (even) filters.push(even);
      width -= width % 2;
      height -= height % 2;
    }
    let fps = input.fps;
    if (p.maxFps !== undefined) {
      if (input.fps > p.maxFps + 0.01) {
        filters.push(`fps=${num(p.maxFps)}`);
        fps = p.maxFps;
      } else if (input.fps <= 0) {
        ctx.log('无法识别原片帧率，忽略 maxFps');
      }
    }
    const vf = filters.length > 0 ? ['-vf', filters.join(',')] : [];

    const keepAudio = !p.removeAudio && input.audioCodecs.length > 0;
    // 没指定音频码率时不超过原音轨码率，压缩不应该让音频反而变大
    const sourceAudio = input.audioBitrate > 0 ? Math.max(32_000, input.audioBitrate) : 0;
    const audioBps =
      p.audioBitrate ??
      (sourceAudio > 0 ? Math.min(DEFAULT_AUDIO_BPS, sourceAudio) : DEFAULT_AUDIO_BPS);
    // libopus 默认的 VBR 在音调单一的素材上会超出目标码率 20% 以上，按大小压缩时改成受限 VBR
    const opusVbr = p.targetSizeMB !== undefined ? ['-vbr', 'constrained'] : [];
    const audioArgs = keepAudio
      ? [
          '-map',
          '0:a:0',
          ...(container === 'webm' ? ['-c:a', 'libopus', ...opusVbr] : ['-c:a', 'aac']),
          '-b:a',
          String(audioBps),
        ]
      : ['-an'];
    const tail = container === 'mp4' ? ['-movflags', '+faststart'] : [];
    const base = ['-i', input.file, '-map', `0:${input.videoIndex}`, ...vf];

    const common = {
      originalSize,
      codec: p.codec,
      format: container,
      width,
      height,
      audioBitrate: keepAudio ? audioBps : 0,
    };

    if (p.targetSizeMB === undefined) {
      const quality = p.quality ?? 'medium';
      const output = ctx.outputPath(container);
      const video = videoCodecArgs(p.codec, p.speed, { crf: CRF[p.codec][quality] });
      await ctx.ffmpeg(
        [...base, ...video, '-pix_fmt', 'yuv420p', ...audioArgs, ...tail, '-y', output],
        { duration },
      );
      const outputSize = (await fs.promises.stat(output)).size;
      return {
        files: [output],
        data: {
          ...common,
          mode: 'quality',
          quality,
          outputSize,
          ratio: ratio(outputSize, originalSize),
        },
      };
    }

    if (duration <= 0) throw new Error('无法获取视频时长，不能按目标大小压缩，请改用 quality');
    const targetBytes = p.targetSizeMB * BYTES_PER_MB;
    // 目标比原文件还大时按原文件大小分配码率：压缩不应该让文件变大
    const cappedByOriginal = originalSize < targetBytes;
    const budgetBytes = cappedByOriginal ? originalSize : targetBytes;
    if (cappedByOriginal) {
      ctx.log(`目标大小超过原文件（${originalSize} 字节），按原文件大小计算码率`);
    }
    // 封装开销：mp4 / webm 每帧索引约 10 字节，再留 1% 给头部和其他元数据
    const frames = duration * (fps > 0 ? fps : 30) + (keepAudio ? duration * 50 : 0);
    const overheadBytes = 1024 + frames * 12 + budgetBytes * 0.01;
    const audioBytes = keepAudio ? (audioBps * duration) / 8 : 0;
    const videoBudget = budgetBytes - overheadBytes - audioBytes;
    let videoBps = Math.floor(((videoBudget * 8) / duration) * RATE_SAFETY);
    if (videoBps < MIN_VIDEO_BPS) {
      if (!cappedByOriginal) {
        const minMB = (overheadBytes + audioBytes + (MIN_VIDEO_BPS * duration) / 8) / BYTES_PER_MB;
        throw new Error(
          `目标大小 ${num(p.targetSizeMB)} MB 太小：${num(duration)} 秒的视频扣除音频和封装开销后，` +
            `画面码率不足 ${MIN_VIDEO_BPS / 1000} kbps（至少需要约 ${minMB.toFixed(2)} MB）。` +
            '请调大 targetSizeMB、降低 audioBitrate 或设置 removeAudio=true',
        );
      }
      // 原文件本身就极小，目标又比它大：按最低码率编码即可
      videoBps = MIN_VIDEO_BPS;
    }

    /**
     * 完整的两遍编码，返回输出大小。第一遍只做码率分析，统计文件写在 workDir（-passlogfile / stats 都只写文件名）。
     * 统计和第一遍的码率有关（x264 的 mbtree / 每帧 QP 都按第一遍的码率算），换码率必须连第一遍一起重跑
     */
    const twoPass = async (
      bitrate: number,
      file: string,
      ranges: [[number, number], [number, number]],
      phases: boolean,
    ): Promise<number> => {
      if (phases) ctx.progress(ranges[0][0], { phase: 'analyzing' });
      const pass1 = videoCodecArgs(p.codec, p.speed, { bitrate, pass: 1 });
      await ctx.ffmpeg([...base, ...pass1, '-pix_fmt', 'yuv420p', '-an', '-f', 'null', '-'], {
        duration,
        range: ranges[0],
      });
      if (phases) ctx.progress(ranges[1][0], { phase: 'processing' });
      const pass2 = videoCodecArgs(p.codec, p.speed, { bitrate, pass: 2 });
      await ctx.ffmpeg(
        [...base, ...pass2, '-pix_fmt', 'yuv420p', ...audioArgs, ...tail, '-y', file],
        { duration, range: ranges[1] },
      );
      return (await fs.promises.stat(file)).size;
    };

    let output = ctx.outputPath(container);
    let outputSize = await twoPass(
      videoBps,
      output,
      [
        [0, 0.4],
        [0.4, 0.95],
      ],
      true,
    );
    let attempts = 1;

    // 超出预算时按超出比例降码率，重新做一次完整的两遍编码
    if (outputSize > budgetBytes) {
      const actualVideo = outputSize - overheadBytes - audioBytes;
      const retryBps =
        actualVideo > 0 ? Math.floor(videoBps * (videoBudget / actualVideo) * RATE_SAFETY) : 0;
      if (retryBps >= MIN_VIDEO_BPS && retryBps < videoBps) {
        ctx.log(
          `输出 ${outputSize} 字节超出预算 ${Math.round(budgetBytes)} 字节，降码率到 ${retryBps} bps 重编`,
        );
        // 重编写到新文件：编码器不一定能达到更低的码率，结果反而更大时保留第一次的
        const retryOutput = ctx.outputPath(container);
        const retrySize = await twoPass(
          retryBps,
          retryOutput,
          [
            [0.95, 0.97],
            [0.97, 1],
          ],
          false,
        );
        attempts = 2;
        if (retrySize < outputSize) {
          await fs.promises.rm(output, { force: true });
          output = retryOutput;
          outputSize = retrySize;
          videoBps = retryBps;
        } else {
          ctx.log(`重编结果 ${retrySize} 字节不比第一次小，保留第一次的结果`);
          await fs.promises.rm(retryOutput, { force: true });
        }
      }
    }
    ctx.progress(1);

    return {
      files: [output],
      data: {
        ...common,
        mode: 'targetSize',
        targetSize: Math.round(targetBytes),
        videoBitrate: videoBps,
        withinTarget: outputSize <= targetBytes,
        attempts,
        outputSize,
        ratio: ratio(outputSize, originalSize),
      },
    };
  },
});

function ratio(outputSize: number, originalSize: number): number {
  return originalSize > 0 ? Math.round((outputSize / originalSize) * 10000) / 10000 : 0;
}
