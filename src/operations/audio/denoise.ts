import fs from 'fs';
import { z } from 'zod';
import { enumParam, numberParam } from '../../schemas/coerce';
import { defineOperation, type OperationContext } from '../types';
import { ZERO_PTS, encodeAudio, num, outputFields, prepareSingle, rethrowWith } from './format';

const STRENGTHS = ['light', 'medium', 'strong'] as const;
type Strength = (typeof STRENGTHS)[number];

/**
 * afftdn 本质是频域噪声门：低于 nf（噪声底）附近的频带衰减 nr dB。nf 必须贴着素材真实的噪声电平才有效，
 * 固定预设对噪声大的录音几乎不起作用，所以先测噪声底，再按强度往上加 margin 作为 nf。
 * margin 越大去得越干净，也越容易压掉弱信号（实测比噪声高 11 dB 的弱信号：light 约 -0.3 dB、strong 约 -3 dB）
 */
const PRESETS: Record<Strength, { nr: number; margin: number; fallbackFloor: number }> = {
  light: { nr: 12, margin: 6, fallbackFloor: -50 },
  medium: { nr: 20, margin: 10, fallbackFloor: -45 },
  strong: { nr: 30, margin: 14, fallbackFloor: -40 },
};

/** 测量用的窗口（秒）和采样噪声用的窗口数（0.5 秒，至少 0.2 秒） */
const WINDOW = 0.1;
const SAMPLE_WINDOWS = 5;
const MIN_SAMPLE_WINDOWS = 2;
/** 最安静的一段比这还响时认为素材里没有只剩底噪的停顿，不采样噪声特征，免得把音乐本身当成噪声 */
export const PAUSE_MAX_DB = -35;
/** 低于它是数字静音（没有噪声可学） */
const DIGITAL_SILENCE_DB = -90;

export interface RmsWindow {
  time: number;
  rms: number;
}

/** 解析 ametadata 打印到文件的每个窗口的 RMS 电平 */
export function parseRmsWindows(text: string): RmsWindow[] {
  const windows: RmsWindow[] = [];
  let time: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const frame = /pts_time:(-?[\d.]+)/.exec(line);
    if (frame) {
      time = Number(frame[1]);
      continue;
    }
    const level = /RMS_level=(\S+)/.exec(line);
    if (level && time !== undefined) {
      const raw = level[1].toLowerCase();
      const rms = raw === '-inf' ? Number.NEGATIVE_INFINITY : Number(raw);
      if (!Number.isNaN(rms)) windows.push({ time, rms });
      time = undefined;
    }
  }
  return windows;
}

export interface NoiseSegment {
  start: number;
  duration: number;
  /** 这一段的平均电平（dBFS） */
  level: number;
}

/**
 * 找平均电平最低、又不是数字静音的连续一段，作为噪声样本。
 * 最后一个窗口可能不满 WINDOW 秒，不参与，保证样本完全落在文件内
 */
export function quietestSegment(windows: RmsWindow[]): NoiseSegment | undefined {
  const usable = windows.slice(0, -1);
  for (let size = SAMPLE_WINDOWS; size >= MIN_SAMPLE_WINDOWS; size--) {
    let best: NoiseSegment | undefined;
    for (let i = 0; i + size <= usable.length; i++) {
      const part = usable.slice(i, i + size);
      if (part.some((w) => !Number.isFinite(w.rms) || w.rms < DIGITAL_SILENCE_DB)) continue;
      // 按功率平均再换回 dB，不能直接平均 dB 值
      const power = part.reduce((sum, w) => sum + 10 ** (w.rms / 10), 0) / size;
      const level = 10 * Math.log10(power);
      if (!best || level < best.level) {
        best = { start: part[0].time, duration: size * WINDOW, level };
      }
    }
    if (best) return best;
  }
  return undefined;
}

async function measureNoise(
  ctx: OperationContext,
  file: string,
  sampleRate: number,
  duration: number,
): Promise<NoiseSegment | undefined> {
  const windowSamples = Math.max(64, Math.round((sampleRate || 48000) * WINDOW));
  const statsFile = 'noise-rms.txt';
  const filter =
    `asetnsamples=n=${windowSamples}:p=0,` +
    'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,' +
    `ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${statsFile}`;
  await ctx
    .ffmpeg(['-i', file, '-map', '0:a:0', '-af', filter, '-f', 'null', '-'], {
      duration,
      range: [0, 0.3],
    })
    .catch(rethrowWith(ctx, '噪声分析失败'));
  const text = await fs.promises.readFile(ctx.tempPath(statsFile), 'utf8').catch(() => '');
  return quietestSegment(parseRmsWindows(text));
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export const denoiseOperation = defineOperation({
  name: 'audio.denoise',
  route: '/api/audio/denoise',
  title: '音频降噪',
  description:
    '自动测量录音的底噪并用 FFT 频域降噪（afftdn）去掉底噪、电流声和环境噪声，可选高通 / 低通滤波去掉低频轰鸣和高频嘶声。',
  inputs: [
    {
      name: 'file',
      kind: 'media',
      required: true,
      description: '音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频）',
    },
  ],
  chainable: true,
  params: z.object({
    strength: enumParam('strength', STRENGTHS).default('medium').meta({
      description:
        '降噪强度：light 轻度 / medium 中等（默认）/ strong 强力；越强越干净，但弱音和人声细节越容易被压掉',
    }),
    reduction: numberParam('reduction', { min: 1, max: 97 }).optional().meta({
      description:
        '噪声最多衰减多少 dB（1-97），覆盖 strength 预设（light 12、medium 20、strong 30）',
    }),
    noiseFloor: numberParam('noiseFloor', { min: -80, max: -20 }).optional().meta({
      description:
        '降噪门限（dBFS，-80 到 -20），低于它的成分按噪声处理；不传时自动测量（底噪电平 + 强度对应的余量）',
    }),
    highpass: numberParam('highpass', { min: 10, max: 2000 }).optional().meta({
      description: '高通截止频率（Hz，10-2000），去掉低于该频率的轰鸣和风噪，人声常用 80-100',
    }),
    lowpass: numberParam('lowpass', { min: 500, max: 48000 }).optional().meta({
      description: '低通截止频率（Hz，500-48000），去掉高于该频率的嘶声，语音常用 8000-12000',
    }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/denoise -F "file=@interview.m4a" -F "strength=strong" -F "highpass=80"',
    '',
    'curl -X POST http://localhost:9527/api/audio/denoise -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/voice.wav", "strength": "light", "lowpass": 12000, "format": "mp3"}\'',
  ].join('\n'),
  notes: [
    '两遍处理：先按 0.1 秒窗口测电平（进度 0-30%），找出最安静的约 0.5 秒（只有底噪的停顿）作为噪声样本，再降噪输出',
    '噪声样本用来学习噪声的频谱形状（对粉红噪声、空调声这类非白噪声效果好得多），降噪门限 = 样本电平 + 余量（light 6 dB、medium 10 dB、strong 14 dB）',
    `最安静的一段也高于 ${PAUSE_MAX_DB} dBFS（如没有停顿的音乐）或整段是数字静音时，不采样噪声，门限退回固定值（light -50、medium -45、strong -40 dBFS），避免把音乐当成噪声；这时可以用 noiseFloor 手动指定`,
    '适合持续、平稳的噪声（底噪、空调、电流声）；突发噪声（敲击、咳嗽）效果有限',
    '处理顺序：高通 → 降噪 → 低通。lowpass 必须大于 highpass；lowpass 不低于输入采样率的一半时没有意义，会被忽略（data.lowpass 为 null）',
    '任务结果 data：strength、reduction、noiseFloor（实际使用的门限）、measuredNoise（测得的底噪电平，无法测量时为 null）、noiseProfile（sampled 采样了噪声特征 / default 默认白噪声特征）、highpass、lowpass',
  ],
  check(params) {
    if (params.highpass !== undefined && params.lowpass !== undefined) {
      if (params.lowpass <= params.highpass) return 'lowpass 必须大于 highpass';
    }
    return undefined;
  },
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);
    const preset = PRESETS[params.strength];
    const reduction = params.reduction ?? preset.nr;
    const nyquist = media.audio.sampleRate / 2;
    if (params.highpass !== undefined && nyquist > 0 && params.highpass >= nyquist) {
      throw new Error(`highpass（${params.highpass} Hz）必须低于输入采样率的一半（${nyquist} Hz）`);
    }
    let lowpass: number | null = null;
    if (params.lowpass !== undefined) {
      if (nyquist > 0 && params.lowpass >= nyquist) {
        ctx.log(`lowpass ${params.lowpass} Hz 不低于奈奎斯特频率 ${nyquist} Hz，已忽略`);
      } else {
        lowpass = params.lowpass;
      }
    }

    ctx.progress(0, { phase: 'analyzing' });
    const segment = await measureNoise(ctx, file, media.audio.sampleRate, media.audioDuration);
    const sample = segment && segment.level <= PAUSE_MAX_DB ? segment : undefined;
    if (!sample) ctx.log('没有找到只有底噪的停顿，使用默认噪声特征');
    const noiseFloor = Math.round(
      params.noiseFloor ??
        (sample ? clamp(sample.level + preset.margin, -80, -20) : preset.fallbackFloor),
    );

    const afftdn = `afftdn=nr=${num(reduction, 2)}:nf=${noiseFloor}`;
    const highpass = params.highpass !== undefined ? `highpass=f=${num(params.highpass, 1)},` : '';
    const tail = lowpass !== null ? `,lowpass=f=${num(lowpass, 1)}` : '';

    let inputs: string[];
    let inputOptions: string[][] | undefined;
    let graph: string;
    if (sample) {
      // 噪声样本接在整段音频前面：afftdn 先在样本上学到噪声特征，再处理整段，处理完把样本裁掉。
      // 样本用第二个解码器单独读（-ss/-t），不用 asplit，否则要把样本之前的音频全部缓存在内存里
      const len = num(sample.duration, 3);
      inputs = [file, file];
      inputOptions = [['-ss', num(sample.start, 3), '-t', len], []];
      graph =
        `[0:a:0][1:a:0]concat=n=2:v=0:a=1,${highpass}` +
        `asendcmd=c='0 afftdn sn start;${len} afftdn sn stop',${afftdn},` +
        `atrim=start=${len},asetpts=PTS-STARTPTS${tail}[out]`;
    } else {
      inputs = [file];
      // 和其它单文件音频操作一样输出从 0 开始（音轨晚于文件开头时不带着偏移）
      graph = `[0:a:0]${ZERO_PTS},${highpass}${afftdn}${tail}[out]`;
    }

    ctx.progress(0.3, { phase: 'processing' });
    const output = await encodeAudio(ctx, {
      inputs,
      inputOptions,
      filterComplex: graph,
      encode: { format, bitrate: params.bitrate, inputChannels: media.audio.channels },
      duration: media.audioDuration,
      range: [0.3, 1],
      errorPrefix: '降噪失败',
    });
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      files: [output],
      data: {
        strength: params.strength,
        reduction,
        noiseFloor,
        measuredNoise: segment ? round(segment.level) : null,
        noiseProfile: sample ? 'sampled' : 'default',
        highpass: params.highpass ?? null,
        lowpass,
      },
    };
  },
});
