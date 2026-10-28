import { z } from 'zod';
import { booleanParam, enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  AAC_ARGS,
  MIX_SAMPLE_RATE,
  decodeLoopAudio,
  num,
  probeOrThrow,
  requireAudio,
  requireVideo,
  videoPassthroughArgs,
} from './common';

const MAX_OFFSET = 24 * 3600;

const params = z.object({
  mode: enumParam('mode', ['mix', 'replace'])
    .default('mix')
    .meta({ description: 'mix：与原声混合；replace：替换原声' }),
  volume: numberParam('volume', { min: 0, max: 3 })
    .default(1)
    .meta({ description: '加入的音频音量倍数（0-3，1 为原始音量）' }),
  originalVolume: numberParam('originalVolume', { min: 0, max: 3 })
    .default(1)
    .meta({ description: 'mix 模式：视频原声的音量倍数（0-3）' }),
  loop: booleanParam('loop').default(false).meta({ description: '加入的音频比视频短时循环播放' }),
  offset: timeParam('offset')
    .refine((v) => v <= MAX_OFFSET, { error: 'offset 不能超过 24 小时' })
    .default(0)
    .meta({ description: '加入的音频从视频的第几秒开始（秒或 HH:MM:SS）' }),
  audioStart: timeParam('audioStart')
    .refine((v) => v <= MAX_OFFSET, { error: 'audioStart 不能超过 24 小时' })
    .default(0)
    .meta({ description: '从加入音频的第几秒开始取（跳过前奏等），秒或 HH:MM:SS' }),
  fadeIn: numberParam('fadeIn', { min: 0, max: 60 })
    .default(0)
    .meta({ description: '加入的音频淡入秒数（0-60）' }),
  fadeOut: numberParam('fadeOut', { min: 0, max: 60 })
    .default(0)
    .meta({ description: '加入的音频在结束前淡出的秒数（0-60）' }),
  ducking: booleanParam('ducking').default(false).meta({
    description: 'mix 模式：原声有人说话时自动压低加入的音频（侧链压缩，适合给口播配背景音乐）',
  }),
});

export const mixAudio = defineOperation({
  name: 'video.mix-audio',
  route: '/api/video/mix-audio',
  title: '添加 / 替换音频',
  description:
    '给视频配上一段音频：与原声混合或替换原声，可调音量、循环、延后开始、淡入淡出，并可在原声说话时自动压低背景音乐。',
  inputs: [
    { name: 'file', kind: 'video', required: true, description: '视频文件' },
    {
      name: 'audio',
      kind: 'audio',
      required: true,
      description: '要加入的音频（背景音乐、配音等）',
    },
  ],
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/mix-audio \\',
    '  -F "file=@video.mp4" -F "audio=@bgm.mp3" \\',
    '  -F "volume=0.4" -F "loop=true" -F "fadeOut=3" -F "ducking=true"',
    '',
    '# URL 输入',
    'curl -X POST http://localhost:9527/api/video/mix-audio \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4","audioUrl":"https://example.com/voice.m4a","mode":"replace"}\'',
  ].join('\n'),
  notes: [
    '输出时长始终等于视频时长：加入的音频更长时截断，更短时补静音（loop=true 时循环）。',
    '画面流复制不重新编码（mp4 装不下的编码会转成 H.264），音频统一编码为 AAC 192k、48 kHz 立体声。',
    '视频本身没有音轨时，mix 模式等同 replace，只输出加入的音频。',
    '混音不做自动降音量（amix normalize=0），再用限幅器防止爆音；原声和加入音频的音量用 originalVolume / volume 调。',
    'loop 时第一遍从 audioStart 开始，之后每一遍都从音频开头循环，接缝处无缝衔接（先解码成 PCM 再循环，mp4 / m4a 里 AAC 末尾的补齐静音会裁掉）。fadeOut 作用在加入音频实际结束的位置。',
  ],
  async run(ctx, p) {
    const input = ctx.inputs.file[0];
    const audioFile = ctx.inputs.audio[0];
    const media = await probeOrThrow((f) => ctx.probe(f), input, '视频');
    const video = requireVideo(media, '输入文件');
    const added = await probeOrThrow((f) => ctx.probe(f), audioFile, '加入的音频');
    const addedAudio = requireAudio(added, '加入的音频文件');
    // 优先用音轨自身的时长：拿视频文件当音频时，整个文件的时长可能是更长的画面
    const addedDuration = addedAudio.duration || added.duration;

    const total = video.duration || media.duration;
    if (!(total > 0)) throw new Error('无法确定视频时长');
    if (p.offset >= total) {
      throw new Error(
        `offset（${p.offset} 秒）不小于视频时长（${num(total)} 秒），加入的音频不会出现`,
      );
    }
    if (!(addedDuration > 0)) throw new Error('无法确定加入音频的时长');
    if (p.audioStart >= addedDuration) {
      throw new Error(`audioStart（${p.audioStart} 秒）超出了音频时长（${num(addedDuration)} 秒）`);
    }

    const needed = total - p.offset;
    // 音频本来就够长时不循环，省掉解码成 PCM 的一步
    const looping = p.loop && addedDuration - p.audioStart < needed;
    const length = looping ? needed : Math.min(needed, addedDuration - p.audioStart);
    const fadeIn = Math.min(p.fadeIn, length);
    const fadeOut = Math.min(p.fadeOut, length);

    // 统一成 48 kHz 立体声再混，amix / sidechaincompress 对不同采样率、声道的输入处理不一致
    const format = `aformat=sample_fmts=fltp:sample_rates=${MIX_SAMPLE_RATE}:channel_layouts=stereo`;
    const bgm = [
      `atrim=start=${num(p.audioStart)}:end=${num(p.audioStart + length)}`,
      'asetpts=PTS-STARTPTS',
      format,
      `volume=${num(p.volume)}`,
    ];
    if (fadeIn > 0) bgm.push(`afade=t=in:st=0:d=${num(fadeIn)}`);
    if (fadeOut > 0) bgm.push(`afade=t=out:st=${num(length - fadeOut)}:d=${num(fadeOut)}`);
    // 补静音到视频长度再精确截断，所有支路一样长，混音和侧链压缩都不会提前结束
    const pad = `apad=whole_dur=${num(total)},atrim=end=${num(total)}`;

    const graph: string[] = [];
    if (p.offset > 0) {
      // 开头的静音用 anullsrc 生成再 concat，不用 adelay：前面的 atrim 要先丢掉 audioStart 秒才输出第一帧，
      // adelay 等不到第一帧就把补的静音发出去了，时间戳无效被下游丢掉（FFmpeg 8.1 实测：mix 时音乐提前到 0 秒，
      // replace 时音轨缺一段）。也不用 aresample 的 first_pts 补静音：它把整段静音一次性缓存在内存里，30 分钟要 1.5 GB
      const lead = Math.round(p.offset * MIX_SAMPLE_RATE);
      graph.push(
        `anullsrc=r=${MIX_SAMPLE_RATE}:cl=stereo,atrim=end_sample=${lead},${format}[lead]`,
        `[1:a]${bgm.join(',')}[music]`,
        `[lead][music]concat=n=2:v=0:a=1,${pad}[bgm]`,
      );
    } else {
      graph.push(`[1:a]${bgm.join(',')},${pad}[bgm]`);
    }
    const mixWithOriginal = p.mode === 'mix' && media.audio;
    if (mixWithOriginal) {
      graph.push(`[0:a:0]${format},volume=${num(p.originalVolume)},${pad}[orig]`);
      let music = '[bgm]';
      let voice = '[orig]';
      if (p.ducking) {
        graph.push('[orig]asplit=2[voice][side]');
        // 原声超过约 -26 dB 时把音乐压低，起效 20 ms、恢复 400 ms，避免音乐忽大忽小
        graph.push(
          '[bgm][side]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[ducked]',
        );
        music = '[ducked]';
        voice = '[voice]';
      }
      // amix 默认 normalize 会把两路都减半；关掉后用 alimiter 防削波（与 compose 一致）。
      // latency=1 补偿 alimiter 5 ms 的预读延迟，否则整条混音（含原声）比画面晚 5 ms、开头多出 5 ms 静音
      graph.push(
        `${voice}${music}amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
          'alimiter=limit=0.97:level=0:latency=1[outa]',
      );
    } else {
      graph.push('[bgm]anull[outa]');
      if (p.mode === 'mix') ctx.log('视频没有音轨，直接使用加入的音频');
    }

    const args = ['-i', input];
    let main: [number, number] = [0, 1];
    if (looping) {
      // 循环用输入级的 -stream_loop，不用 aloop 滤镜：aloop 要把整段音频缓存在内存里。
      // 循环的是先解码好的 PCM，压缩音频直接循环接缝处有空洞，见 decodeLoopAudio
      const pcm = await decodeLoopAudio(ctx, audioFile, addedDuration, [0, 0.05]);
      args.push('-stream_loop', '-1', '-i', pcm);
      main = [0.05, 1];
    } else {
      args.push('-i', audioFile);
    }
    args.push('-filter_complex', graph.join(';'));
    args.push('-map', '0:v:0', '-map', '[outa]', ...videoPassthroughArgs(video, 'mp4'));
    args.push(...AAC_ARGS, '-ar', String(MIX_SAMPLE_RATE), '-t', num(total));
    args.push('-movflags', '+faststart');
    const output = ctx.outputPath('mp4');
    args.push('-y', output);
    await ctx.ffmpeg(args, { duration: total, range: main });
    return { files: [output] };
  },
});
