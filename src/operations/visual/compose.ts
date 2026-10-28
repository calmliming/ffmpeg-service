import { z } from 'zod';
import { toBoolean, toNumber } from '../../schemas/coerce';
import { composeFiles, type ComposeStage } from '../../services/compose.service';
import { defineOperation } from '../types';

const MAX_VIDEOS = 100;

// 与旧版 composeSchema 的转换和报错保持一致：PHP / Go 客户端把数字、布尔值发成字符串
const params = z.object({
  musicVolume: z
    .preprocess(
      toNumber,
      z
        .number({ error: 'musicVolume 必须是 0 到 1 之间的数字' })
        .min(0, { error: 'musicVolume 不能小于 0' })
        .max(1, { error: 'musicVolume 不能大于 1' }),
    )
    .default(1)
    .meta({ description: '背景音乐音量 0-1，默认 1' }),
  muteOriginalAudio: z
    .preprocess(toBoolean, z.boolean({ error: 'muteOriginalAudio 必须是布尔值' }))
    .default(false)
    .meta({ description: '是否消除视频原声，只保留背景音乐，默认 false' }),
});

export const compose = defineOperation({
  name: 'compose',
  route: '/api/compose',
  title: '视频合成（拼接 + 背景音乐）',
  description:
    '把多个视频按顺序拼接成一个 mp4，可叠加背景音乐。参数一致时直接流复制，不一致时先统一转码再拼接。',
  inputs: [
    {
      name: 'videos',
      kind: 'video',
      required: true,
      multiple: { min: 1, max: MAX_VIDEOS },
      urlFields: ['videos'],
      description: `要拼接的视频，按顺序 1-${MAX_VIDEOS} 个；可上传多个 videos 文件，或用 videos 传 URL 数组`,
    },
    {
      name: 'music',
      kind: 'audio',
      required: false,
      urlFields: ['music'],
      description: '背景音乐，可上传文件或用 music 传 URL',
    },
  ],
  params,
  downloadShare: 0.55,
  example: [
    'curl -X POST http://localhost:9527/api/compose \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '{",
    '    "videos": [',
    '      "https://example.com/video1.mp4",',
    '      "https://example.com/video2.mp4"',
    '    ],',
    '    "music": "https://example.com/bgm.mp3",',
    '    "musicVolume": 0.8',
    "  }'",
    '',
    '# 也可以直接上传文件',
    'curl -X POST http://localhost:9527/api/compose \\',
    '  -F "videos=@part1.mp4" -F "videos=@part2.mp4" \\',
    '  -F "music=@bgm.mp3" -F "muteOriginalAudio=true"',
  ].join('\n'),
  notes: [
    `最多 ${MAX_VIDEOS} 个视频；URL 输入先带重试地下载到本地，下载阶段占进度的 55%`,
    '所有片段的编码、分辨率、帧率和音轨参数一致时直接流复制拼接，速度最快',
    '参数不一致时，先把每个片段统一转码成第 1 个视频的分辨率和帧率（等比缩放、黑边补齐），缺音轨的片段补静音，再拼接',
    '手机竖拍等带旋转信息、或像素宽高比不是 1:1 的片段，与其他片段不一致时会先统一转码并自动转正；统一转码的画布取第 1 个视频实际显示的宽高',
    '默认原声与背景音乐混合：原声保持原音量，背景音乐按 musicVolume 缩放，混合后自动限幅防止爆音',
    'muteOriginalAudio=true 只保留背景音乐；同时不传 music 时输出无声视频',
    '输出时长以视频总时长为准：音乐不够长时补静音，音乐过长时截断',
    '任务详情的 phase 依次为 downloading（仅 URL 输入）→ processing（探测片段，很短）→ normalizing（仅参数不一致时）→ merging；currentVideoIndex / totalVideos 表示正在处理第几个片段',
    '片段里不能有纯音频文件；背景音乐必须包含音轨，否则任务失败并指出是第几个文件',
  ],
  async run(ctx, p) {
    const videoFiles = [...ctx.inputs.videos];
    const musicFile = ctx.inputs.music?.[0];
    const totalVideos = videoFiles.length;
    // 探测完才知道要不要统一转码，阶段等 onStage 再报，不先报一个 merging 又跳回 normalizing
    let phase: ComposeStage = 'merging';
    let fraction = 0;
    ctx.progress(0, { totalVideos });

    const output = ctx.outputPath('mp4');
    const result = await composeFiles({
      signal: ctx.signal,
      videoFiles,
      musicFile,
      musicVolume: p.musicVolume,
      muteOriginalAudio: p.muteOriginalAudio,
      output,
      workDir: ctx.workDir,
      prefix: ctx.taskId.replace(/[^A-Za-z0-9_-]/g, '_'),
      onStage: (stage) => {
        phase = stage;
        if (stage === 'normalizing') ctx.log('片段参数不一致，先统一转码');
        ctx.progress(fraction, { phase, totalVideos });
      },
      onProgress: (done, segment) => {
        fraction = done;
        ctx.progress(done, { phase, currentVideoIndex: segment, totalVideos });
      },
    });
    if (result.normalized) ctx.log(`统一转码原因: ${result.reasons.join('; ')}`);

    ctx.progress(1, { phase: 'merging', currentVideoIndex: totalVideos, totalVideos });
    return {
      files: [output],
      data: { duration: result.duration, normalized: result.normalized, reasons: result.reasons },
    };
  },
});
