import { z } from 'zod';
import { booleanParam, enumParam, toList, toNumber } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { conformChain, pickMixTarget, type MixTarget } from './concat';
import {
  decodedDuration,
  encodeAudio,
  fitSampleRate,
  mapLimit,
  num,
  outputFields,
  probeAudio,
  outputFormat,
} from './format';
import { LIMITER } from './volume';

export const MAX_MIX_FILES = 8;
const DURATIONS = ['longest', 'shortest', 'first'] as const;

function numberList(name: string, min: number, max: number, unit: string) {
  const message = `${name} 必须是逗号分隔的数字列表（如 1,0.5），每项 ${min} 到 ${max}${unit}`;
  return z.preprocess(
    toList,
    z.array(
      z.preprocess(
        toNumber,
        z.number({ error: message }).min(min, { error: message }).max(max, { error: message }),
      ),
      { error: message },
    ),
  );
}

export function mixGraph(
  target: MixTarget,
  inputChannels: readonly number[],
  volumes: readonly number[],
  delays: readonly number[],
  duration: (typeof DURATIONS)[number],
  limiter: boolean,
): string {
  const count = volumes.length;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    let chain = conformChain(i, target, inputChannels[i]);
    if (volumes[i] !== 1) chain += `,volume=${num(volumes[i], 4)}`;
    if (delays[i] > 0) chain += `,adelay=delays=${Math.round(delays[i] * 1000)}:all=1`;
    parts.push(`${chain}[m${i}]`);
  }
  const labels = Array.from({ length: count }, (_, i) => `[m${i}]`).join('');
  // amix 默认 normalize 会按输入数把每路都压低，一路结束后其它路又跳回原音量；关掉后用限幅器防削波
  const mix = `amix=inputs=${count}:duration=${duration}:dropout_transition=0:normalize=0`;
  parts.push(`${labels}${mix}${limiter ? `,${LIMITER}` : ''}[out]`);
  return parts.join(';');
}

export const mixAudioOperation = defineOperation({
  name: 'audio.mix',
  route: '/api/audio/mix',
  title: '多轨混音',
  description: '把多个音频叠在一起同时播放（如人声 + 背景音乐），每一轨可以单独设音量和起始延迟。',
  inputs: [
    {
      name: 'files',
      kind: 'media',
      required: true,
      multiple: { min: 2, max: MAX_MIX_FILES },
      description: `要混合的音频（或带音轨的视频），2-${MAX_MIX_FILES} 个`,
    },
  ],
  params: z.object({
    volumes: numberList('volumes', 0, 10, ' 倍').optional().meta({
      description:
        '每一轨的音量倍数，逗号分隔或数组，个数必须等于文件数（如 1,0.3：第 1 轨原音量、第 2 轨 30%），默认都为 1',
    }),
    delays: numberList('delays', 0, 3600, ' 秒').optional().meta({
      description: '每一轨延迟多少秒开始（0-3600），逗号分隔或数组，个数必须等于文件数，默认都为 0',
    }),
    duration: enumParam('duration', DURATIONS).default('longest').meta({
      description: '输出时长：longest 最长的一轨（默认）/ shortest 最短的一轨 / first 第一轨',
    }),
    limiter: booleanParam('limiter')
      .default(true)
      .meta({ description: '混音后加限幅器防止叠加后削波，默认 true' }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/mix -F "files=@voice.wav" -F "files=@bgm.mp3" -F "volumes=1,0.25" -F "duration=first"',
    '',
    'curl -X POST http://localhost:9527/api/audio/mix -H "Content-Type: application/json" \\',
    '  -d \'{"filesUrls": ["https://example.com/voice.mp3", "https://example.com/bgm.mp3"], "volumes": [1, 0.3], "delays": [2, 0]}\'',
  ].join('\n'),
  notes: [
    `2-${MAX_MIX_FILES} 个文件；视频文件只取第一条音轨`,
    '各轨按原音量相加（不做 amix 默认的平均衰减），所以加在一起可能变响；默认开启的限幅器把峰值压在约 -0.26 dBFS',
    '所有输入先统一采样率（取最高的）和声道（任一输入是多声道就输出立体声）；单声道输入原样复制到左右声道，音量不变',
    'duration 计算包含 delays；不传 format 时沿用第 1 个文件的格式（不是可输出的音频格式时用 mp3）',
    '有输入没有时长信息（管道写出的 webm、浏览器 MediaRecorder 录音）时编码中不汇报细分进度，任务结果 data.duration 取实际输出的长度',
  ],
  check(params, provided) {
    const count = provided.files ?? 0;
    if (params.volumes && params.volumes.length !== count) {
      return `volumes 需要 ${count} 个值（每个文件一个），实际收到 ${params.volumes.length} 个`;
    }
    if (params.delays && params.delays.length !== count) {
      return `delays 需要 ${count} 个值（每个文件一个），实际收到 ${params.delays.length} 个`;
    }
    return undefined;
  },
  async run(ctx, params) {
    const files = ctx.inputs.files ?? [];
    if (files.length < 2) throw new Error('至少需要 2 个音频文件');
    const volumes = params.volumes ?? files.map(() => 1);
    const delays = params.delays ?? files.map(() => 0);
    if (volumes.length !== files.length || delays.length !== files.length) {
      throw new Error('volumes / delays 的个数必须等于文件数');
    }

    ctx.progress(0, { phase: 'analyzing' });
    const items = await mapLimit(files, 4, (file, i) =>
      probeAudio(ctx, file, `第 ${i + 1} 个文件`),
    );
    const format = outputFormat(items[0], params.format);
    const target = pickMixTarget(items, (rate) => fitSampleRate(format, rate));

    const ends = items.map((m, i) => m.audioDuration + delays[i]);
    const total =
      params.duration === 'first'
        ? ends[0]
        : params.duration === 'shortest'
          ? Math.min(...ends)
          : Math.max(...ends);
    // 有输入拿不到时长（管道写出的 webm、MediaRecorder 录音）时算出的总长不可信：
    // 不按它汇报进度，结果里的 duration 改用编码统计里实际输出的长度
    const known = items.every((m) => m.audioDuration > 0);
    let measured: number | undefined;

    ctx.progress(0, { phase: 'merging' });
    const output = await encodeAudio(ctx, {
      inputs: files,
      filterComplex: mixGraph(
        target,
        items.map((m) => m.audio.channels),
        volumes,
        delays,
        params.duration,
        params.limiter,
      ),
      encode: { format, bitrate: params.bitrate, inputChannels: target.channels },
      duration: known && total > 0 ? total : undefined,
      errorPrefix: '混音失败',
      ...(known ? {} : { onStderr: (stderr: string) => (measured = decodedDuration(stderr)) }),
    });
    const duration = known ? total : (measured ?? total);
    return {
      files: [output],
      data: {
        inputs: files.length,
        duration: Math.round(Math.max(0, duration) * 1000) / 1000,
        sampleRate: target.sampleRate,
        channels: target.channels,
      },
    };
  },
});
