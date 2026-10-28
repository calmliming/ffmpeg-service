import { z } from 'zod';
import { booleanParam, numberParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { encodeAudio, errorMessage, num, outputFields, prepareSingle } from './format';

/** atempo 拆成每级 0.5-2 的串联，单级倍率过大时音质下降明显 */
export function atempoChain(factor: number): string[] {
  const parts: number[] = [];
  let rest = factor;
  while (rest > 2) {
    parts.push(2);
    rest /= 2;
  }
  while (rest < 0.5) {
    parts.push(0.5);
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 1e-9 || parts.length === 0) parts.push(rest);
  return parts.map((p) => `atempo=${num(p)}`);
}

/** 半音换算成频率倍数 */
export function pitchRatio(semitones: number): number {
  return 2 ** (semitones / 12);
}

/** 不带 librubberband 的 FFmpeg 上用的变调方案：改采样率变调（会同时变速），再用 atempo 把速度拉回来 */
export function asetrateFilter(tempo: number, semitones: number, sampleRate: number): string {
  const ratio = pitchRatio(semitones);
  const rate = sampleRate > 0 ? sampleRate : 48000;
  return [
    `asetrate=${Math.round(rate * ratio)}`,
    `aresample=${rate}`,
    ...atempoChain(tempo / ratio),
  ].join(',');
}

export function rubberbandFilter(tempo: number, semitones: number, formant: boolean): string {
  const opts = [`tempo=${num(tempo)}`, `pitch=${num(pitchRatio(semitones))}`];
  if (formant) opts.push('formant=preserved');
  return `rubberband=${opts.join(':')}`;
}

export const speedOperation = defineOperation({
  name: 'audio.speed',
  route: '/api/audio/speed',
  title: '变速 / 变调',
  description: '改变音频播放速度而不改变音高，或者升降调而不改变速度，两者也可以同时调整。',
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
    tempo: numberParam('tempo', { min: 0.5, max: 4 })
      .default(1)
      .meta({ description: '速度倍数（0.5-4），1 为原速、1.5 加快 50%、0.75 放慢；音高不变' }),
    pitch: numberParam('pitch', { min: -12, max: 12 })
      .default(0)
      .meta({ description: '升降调（半音，-12 到 12，可以是小数），12 为升高一个八度；速度不变' }),
    preserveFormant: booleanParam('preserveFormant')
      .default(false)
      .meta({ description: '变调时保留共振峰，人声听起来更自然（不像花栗鼠），默认 false' }),
    ...outputFields,
  }),
  example: [
    'curl -X POST http://localhost:9527/api/audio/speed -F "file=@lecture.mp3" -F "tempo=1.5"',
    '',
    '# 降 2 个半音并保留人声音色',
    'curl -X POST http://localhost:9527/api/audio/speed -H "Content-Type: application/json" \\',
    '  -d \'{"url": "https://example.com/song.mp3", "pitch": -2, "preserveFormant": true}\'',
  ].join('\n'),
  notes: [
    'tempo 和 pitch 至少要改一个',
    '只变速时用 atempo（WSOLA 算法）；变调时用 rubberband（librubberband），FFmpeg 没有编译 rubberband 时自动退回 asetrate + atempo 方案（此时 preserveFormant 无效）',
    '输出时长 = 原时长 / tempo；任务结果 data.engine 说明实际使用的算法',
  ],
  check(params) {
    if (params.tempo === 1 && params.pitch === 0)
      return '请设置 tempo（不等于 1）或 pitch（不等于 0）';
    return undefined;
  },
  async run(ctx, params) {
    const { file, media, format } = await prepareSingle(ctx, params.format);
    const { tempo, pitch } = params;
    const duration = media.audioDuration > 0 ? media.audioDuration / tempo : undefined;
    const encode = { format, bitrate: params.bitrate, inputChannels: media.audio.channels };
    const run = (filter: string) =>
      encodeAudio(ctx, { inputs: [file], filter, encode, duration, errorPrefix: '变速变调失败' });

    if (pitch === 0) {
      const output = await run(atempoChain(tempo).join(','));
      return { files: [output], data: { tempo, pitch, engine: 'atempo' } };
    }

    // FFmpeg 的 rubberband 滤镜在输入结束时不冲刷内部延迟，结尾会丢 80-150 ms：
    // 先补 0.5 秒静音把尾巴推出来，再按预期时长裁掉多余部分
    const rubberband = rubberbandFilter(tempo, pitch, params.preserveFormant);
    const padded = duration
      ? `apad=pad_dur=0.5,${rubberband},atrim=end=${num(duration)}`
      : rubberband;
    try {
      const output = await run(padded);
      return { files: [output], data: { tempo, pitch, engine: 'rubberband' } };
    } catch (err) {
      const message = errorMessage(err);
      const missing = /rubberband/i.test(message) && /no such filter|not found/i.test(message);
      if (ctx.signal.aborted || !missing) throw err;
      ctx.log('FFmpeg 没有 rubberband 滤镜，改用 asetrate + atempo 变调');
    }
    const output = await run(asetrateFilter(tempo, pitch, media.audio.sampleRate));
    return { files: [output], data: { tempo, pitch, engine: 'asetrate' } };
  },
});
