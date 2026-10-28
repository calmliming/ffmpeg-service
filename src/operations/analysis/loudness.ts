import { z } from 'zod';
import { booleanParam, numberParam } from '../../schemas/coerce';
import { decodedDuration } from '../audio/format';
import { MIN_R128_SECONDS } from '../audio/loudnorm';
import { defineOperation } from '../types';
import {
  filterLogLines,
  fileInput,
  parseDb,
  parseMetadataFrames,
  probeInput,
  readOptionalFile,
  round,
} from './shared';

/** 响度曲线最多返回的点数，超过时按更长的间隔取样 */
const MAX_TIMELINE_POINTS = 3600;
/** ebur128 的绝对门限，低于它按静音处理 */
const FLOOR_LUFS = -70;
/** 太短、测不出综合响度的片段按采样峰值判断静音：峰值 -70 dBFS 的声音响度远低于 -70 LUFS 的门限 */
const SILENT_PEAK_DBFS = -70;

const params = z.object({
  timeline: booleanParam('timeline').default(false).meta({
    description:
      '同时返回响度曲线：默认每秒一个点，含瞬时响度 momentary（400 毫秒窗口）和短期响度 shortTerm（3 秒窗口），单位 LUFS',
  }),
  target: numberParam('target', { min: -70, max: -5 }).optional().meta({
    description:
      '目标响度（LUFS），如 -14（主流流媒体平台）、-16（播客）、-23（EBU R128 广播）。给了会额外返回达到目标需要的增益和增益后的真峰值',
  }),
});

export interface LoudnessSummary {
  integratedLufs: number | null;
  thresholdLufs: number | null;
  lraLu: number | null;
  lraLowLufs: number | null;
  lraHighLufs: number | null;
  samplePeakDbfs: number | null;
  truePeakDbtp: number | null;
}

/** 解析 ebur128 结束时打印的 Summary 块。块内各行没有滤镜前缀，按小节标题区分两个 Threshold 和两个 Peak */
export function parseEbur128Summary(stderr: string): LoudnessSummary | undefined {
  const lines = stderr.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\[Parsed_ebur128_\d+ @ [^\]]+\] Summary:\s*$/.test(l));
  if (start < 0) return undefined;
  const summary: LoudnessSummary = {
    integratedLufs: null,
    thresholdLufs: null,
    lraLu: null,
    lraLowLufs: null,
    lraHighLufs: null,
    samplePeakDbfs: null,
    truePeakDbtp: null,
  };
  let section = '';
  for (const line of lines.slice(start + 1)) {
    // 下一条带前缀的日志意味着 Summary 结束
    if (line.startsWith('[')) break;
    const heading = /^\s*(Integrated loudness|Loudness range|Sample peak|True peak):\s*$/.exec(
      line,
    );
    if (heading) {
      section = heading[1];
      continue;
    }
    const entry =
      /^\s*([A-Za-z ]+):\s+(-?(?:\d+(?:\.\d+)?|inf|nan))\s*(LUFS|LU|dBFS|dBTP)?\s*$/i.exec(line);
    if (!entry) continue;
    const [, key, value] = entry;
    const db = parseDb(value);
    if (section === 'Integrated loudness' && key === 'I') summary.integratedLufs = db;
    else if (section === 'Integrated loudness' && key === 'Threshold') summary.thresholdLufs = db;
    else if (section === 'Loudness range' && key === 'LRA') summary.lraLu = db;
    else if (section === 'Loudness range' && key === 'LRA low') summary.lraLowLufs = db;
    else if (section === 'Loudness range' && key === 'LRA high') summary.lraHighLufs = db;
    else if (section === 'Sample peak' && key === 'Peak') summary.samplePeakDbfs = db;
    else if (section === 'True peak' && key === 'Peak') summary.truePeakDbtp = db;
  }
  return summary;
}

/** volumedetect 的平均 / 最大音量（dB），取最后一次输出（滤镜图初始化时可能先打印一次空统计） */
export function parseVolumedetect(stderr: string): {
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
} {
  let mean: number | null = null;
  let max: number | null = null;
  for (const line of filterLogLines(stderr, 'volumedetect')) {
    const m = /^(mean|max)_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'mean') mean = parseDb(m[2]);
    else max = parseDb(m[2]);
  }
  return { meanVolumeDb: mean, maxVolumeDb: max };
}

/** 曲线上的值：-inf、缺失都记为门限值 */
function floorLufs(text: string | undefined): number {
  const value = Number(text);
  return round(Number.isFinite(value) ? Math.max(FLOOR_LUFS, value) : FLOOR_LUFS, 1);
}

export const loudness = defineOperation({
  name: 'analyze.loudness',
  route: '/api/analyze/loudness',
  title: '响度分析',
  description:
    '按 EBU R128 / ITU-R BS.1770 测量音频或视频音轨的综合响度（LUFS）、响度范围（LRA）和真峰值（dBTP），并给出平均 / 最大音量。',
  inputs: [fileInput('media', '要分析的音频或带音轨的视频')],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/analyze/loudness \\',
    '  -F "file=@input.mp3" -F "target=-14"',
    '',
    '# URL 输入，同时返回响度曲线',
    'curl -X POST http://localhost:9527/api/analyze/loudness \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","timeline":true}\'',
  ].join('\n'),
  notes: [
    '结果在任务详情的 result 里：integratedLufs（综合响度）、lraLu（响度范围）、truePeakDbtp（真峰值）、samplePeakDbfs（采样峰值）、thresholdLufs、lraLowLufs、lraHighLufs，以及 volumedetect 的 meanVolumeDb / maxVolumeDb。',
    '全程静音时 integratedLufs 为 -70、silent 为 true，峰值、thresholdLufs、lraLowLufs、lraHighLufs 为 null，lraLu 为 0。',
    `音频短于 ${MIN_R128_SECONDS} 秒（如短音效）时凑不满一个 EBU R128 测量块，tooShort 为 true，integratedLufs、thresholdLufs、lraLu、lraLowLufs、lraHighLufs 和 target.gainDb 为 null；峰值和平均 / 最大音量照常返回，silent 只在采样峰值低于 -70 dBFS 时为 true。`,
    'duration 取容器时长和实际解码长度中较大的一个，没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录音）也能拿到真实时长。',
    '给了 target 时返回 target 对象：gainDb 是达到目标需要的增益，truePeakAfterGainDbtp 是增益后的真峰值，超过 -1 dBTP 时 clipRisk 为 true（直接放大会削波，建议用 /api/audio/normalize 做带限幅的响度标准化）。',
    'timeline=true 时返回 timeline.points：[{ time, momentary, shortTerm }]，默认每秒一个点，超过 3600 个点时自动加大间隔（interval 字段）；低于 -70 LUFS 的值记为 -70。',
    '多音轨文件只分析第一条音轨；没有音轨的文件直接失败。',
  ],
  async run(ctx, p) {
    const media = await probeInput(ctx, 'audio');
    const duration = media.duration;
    const interval = Math.max(1, Math.ceil(duration / MAX_TIMELINE_POINTS));

    // metadata=1 时逐帧数据走 framelog=verbose 不进 info 日志，长音频的 stderr 才不会膨胀
    const filters = [
      `ebur128=peak=sample+true:framelog=verbose${p.timeline ? ':metadata=1' : ''}`,
      'volumedetect',
    ];
    if (p.timeline) {
      // ebur128 开了 metadata 后按 100 毫秒一帧输出，每 interval 秒取一帧写进文件
      filters.push(
        `aselect='not(mod(n,${interval * 10}))'`,
        'ametadata=mode=print:file=loudness.txt',
      );
    }
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
        filters.join(','),
        '-f',
        'null',
        '-',
      ],
      { duration, logLevel: 'info', captureStderr: true },
    );

    const summary = parseEbur128Summary(stderr);
    if (!summary || summary.integratedLufs === null) {
      throw new Error('没有拿到响度测量结果，音轨可能已损坏');
    }
    const volume = parseVolumedetect(stderr);
    // 容器里没有时长（管道写出的 webm、浏览器 MediaRecorder 录音）时用实际解码出的长度
    const decoded = decodedDuration(stderr) ?? 0;
    const totalDuration = Math.max(duration, decoded);
    // 不够一个 400 毫秒测量块时 ebur128 不管多响都报 -70，不能据此判断静音，综合响度也没有意义。
    // 只在确实没测出来时才看时长，容器里的时长写错也不会把正常的测量结果丢掉
    const audioLength = media.audio?.duration || decoded || duration;
    const tooShort =
      summary.integratedLufs <= FLOOR_LUFS && audioLength > 0 && audioLength < MIN_R128_SECONDS;
    const samplePeak = summary.samplePeakDbfs;
    const integrated = tooShort ? null : round(summary.integratedLufs, 1);
    const truePeak = summary.truePeakDbtp === null ? null : round(summary.truePeakDbtp, 1);
    const silent = tooShort
      ? samplePeak === null || samplePeak <= SILENT_PEAK_DBFS
      : integrated !== null && integrated <= FLOOR_LUFS;
    const db = (value: number | null) => (value === null ? null : round(value, 1));
    // 全程静音或太短时 ebur128 把门限和 LRA 上下限打印成 0.0，没有意义
    const gated = (value: number | null) => (silent || tooShort ? null : db(value));

    const data: Record<string, unknown> = {
      duration: round(totalDuration, 3),
      integratedLufs: integrated,
      thresholdLufs: gated(summary.thresholdLufs),
      lraLu: tooShort ? null : silent ? 0 : db(summary.lraLu),
      lraLowLufs: gated(summary.lraLowLufs),
      lraHighLufs: gated(summary.lraHighLufs),
      truePeakDbtp: truePeak,
      samplePeakDbfs: db(samplePeak),
      meanVolumeDb: db(volume.meanVolumeDb),
      maxVolumeDb: db(volume.maxVolumeDb),
      silent,
      tooShort,
    };

    if (p.target !== undefined) {
      // 静音素材没有可放大的内容；太短的素材测不出综合响度，增益都没有意义
      const gain = silent || integrated === null ? null : round(p.target - integrated, 1);
      const peakAfter = gain === null || truePeak === null ? null : round(truePeak + gain, 1);
      data.target = {
        targetLufs: p.target,
        gainDb: gain,
        truePeakAfterGainDbtp: peakAfter,
        clipRisk: peakAfter !== null && peakAfter > -1,
      };
    }

    if (p.timeline) {
      const frames = parseMetadataFrames(await readOptionalFile(ctx.tempPath('loudness.txt')));
      const points = frames.slice(0, MAX_TIMELINE_POINTS + 1).map((f) => ({
        time: round(f.time, 1),
        momentary: floorLufs(f.values.get('lavfi.r128.M')),
        shortTerm: floorLufs(f.values.get('lavfi.r128.S')),
      }));
      data.timeline = { interval, points };
    }

    return { files: [], data };
  },
});
