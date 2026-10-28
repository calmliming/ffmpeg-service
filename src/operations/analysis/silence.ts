import { z } from 'zod';
import { numberParam } from '../../schemas/coerce';
import { decodedDuration } from '../audio/format';
import { defineOperation } from '../types';
import {
  MAX_INTERVALS,
  complement,
  filterLogLines,
  fileInput,
  makeInterval,
  num,
  probeInput,
  round,
  totalDuration,
  type Interval,
} from './shared';

const params = z.object({
  noise: numberParam('noise', { min: -90, max: 0 }).default(-50).meta({
    description: '静音阈值（dB），低于它算静音，默认 -50。嘈杂的录音可以调高到 -40 ~ -30',
  }),
  minDuration: numberParam('minDuration', { min: 0.01, max: 3600 })
    .default(0.5)
    .meta({ description: '最短静音时长（秒），短于它的停顿不计入，默认 0.5' }),
});

/**
 * 解析 silencedetect 的日志：silence_start: 1.2 / silence_end: 2.5 | silence_duration: 1.3。
 * 文件结尾还在静音时较新的 FFmpeg 会在结束时补一条 silence_end，没有的话用总时长收尾
 */
export function parseSilences(stderr: string, duration: number): Interval[] {
  const result: Interval[] = [];
  let start: number | undefined;
  for (const line of filterLogLines(stderr, 'silencedetect')) {
    const s = /^silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) {
      start = Number(s[1]);
      continue;
    }
    const e = /^silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/.exec(
      line,
    );
    if (e) {
      const end = Number(e[1]);
      result.push(makeInterval(start ?? end - Number(e[2]), end));
      start = undefined;
    }
  }
  if (start !== undefined && duration > start) result.push(makeInterval(start, duration));
  return result;
}

/** 统计里的 time= 只精确到 10 毫秒，判断静音是否延续到音轨结尾时留这么多余量 */
const END_TOLERANCE = 0.02;

/**
 * 音轨比画面先结束时，音轨结尾到文件结尾这段没有声音，也算静音：
 * 紧接在结尾静音之后就并进去，单独一段时按 minDuration 判断（和 silencedetect 的规则一致）
 */
export function extendTail(
  silences: Interval[],
  audioEnd: number,
  duration: number,
  minDuration: number,
): Interval[] {
  if (duration - audioEnd <= 0.001) return silences;
  const last = silences.at(-1);
  if (last && last.end >= audioEnd - END_TOLERANCE) {
    return [...silences.slice(0, -1), makeInterval(last.start, duration)];
  }
  if (duration - audioEnd >= minDuration) {
    return [...silences, makeInterval(audioEnd, duration)];
  }
  return silences;
}

export const silence = defineOperation({
  name: 'analyze.silence',
  route: '/api/analyze/silence',
  title: '静音检测',
  description: '找出音频或视频音轨里的静音片段，同时给出有声片段，可用于自动剪掉停顿、切分录音。',
  inputs: [fileInput('media', '要分析的音频或带音轨的视频')],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/analyze/silence \\',
    '  -F "file=@podcast.mp3" -F "noise=-45" -F "minDuration=1"',
    '',
    '# URL 输入',
    'curl -X POST http://localhost:9527/api/analyze/silence \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/talk.m4a","noise":-50,"minDuration":0.5}\'',
  ].join('\n'),
  notes: [
    '结果：silences（静音区间 [{ start, end, duration }]，秒）、totalSilence（静音总时长）、nonSilent（静音之外的有声区间）、silenceRatio（静音占比 0-1）。',
    '时间按文件的时间轴（和播放器一致）：音轨晚于画面开始、或比画面先结束时，没有声音的开头 / 结尾也算静音（同样要达到 minDuration）。没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录音）按实际解码长度计算。',
    '多声道音频要所有声道都低于阈值才算静音；多音轨文件只分析第一条音轨，没有音轨的文件直接失败。',
    `区间最多返回 ${MAX_INTERVALS} 条，超过时 truncated 为 true。`,
  ],
  async run(ctx, p) {
    const media = await probeInput(ctx, 'audio');
    const { stderr } = await ctx.ffmpeg(
      [
        '-i',
        ctx.inputs.file[0],
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-af',
        // 音轨晚于文件开头时，在前面补上静音让它从 0 开始：结果按文件时间轴，开头没有声音的部分算静音
        `aresample=async=1:first_pts=0,silencedetect=noise=${num(p.noise)}dB:d=${num(p.minDuration)}`,
        '-f',
        'null',
        '-',
      ],
      { duration: media.duration, logLevel: 'info', captureStderr: true },
    );
    // 音轨实际结束的时间：容器里没有时长（media.duration 为 0）时只能靠它收尾
    const audioEnd = decodedDuration(stderr) ?? media.duration;
    const detected = parseSilences(stderr, audioEnd);
    const duration = Math.max(media.duration, audioEnd, detected.at(-1)?.end ?? 0);
    const all = extendTail(detected, audioEnd, duration, p.minDuration);
    const silences = all.slice(0, MAX_INTERVALS);
    const total = totalDuration(all);
    return {
      files: [],
      data: {
        duration: round(duration, 3),
        noise: p.noise,
        minDuration: p.minDuration,
        count: all.length,
        totalSilence: total,
        silenceRatio: duration > 0 ? round(Math.min(1, total / duration), 4) : 0,
        silences,
        nonSilent: complement(all, duration).slice(0, MAX_INTERVALS),
        truncated: all.length > MAX_INTERVALS,
      },
    };
  },
});
