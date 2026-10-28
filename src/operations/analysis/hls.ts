import path from 'path';
import { z } from 'zod';
import { enumParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import { fileInput, probeDisplay, round } from './shared';
import {
  MAX_RENDITIONS,
  MAX_SEGMENTS,
  audioBitrateParam,
  checkSegmentCount,
  ladderFilter,
  listFiles,
  muxerDir,
  outputFps,
  planRenditions,
  renditionsParam,
  segmentDurationParam,
  videoEncodeArgs,
} from './streaming';

const params = z.object({
  renditions: renditionsParam()
    .optional()
    .meta({
      description: `清晰度列表（短边像素，横屏即高度），逗号分隔，如 1080,720,480，最多 ${MAX_RENDITIONS} 档。默认：源画面一档加上更低的标准档（1080/720/480/360/240…）。高于源画面的档位会被丢掉，不放大`,
    }),
  segmentDuration: segmentDurationParam(6).meta({
    description: '每个分片的时长（秒，2-10 的整数），默认 6',
  }),
  audioBitrate: audioBitrateParam().meta({
    description: '每档的 AAC 音频码率，32k-320k，默认 128k',
  }),
  segmentType: enumParam('segmentType', ['ts', 'fmp4'] as const)
    .default('ts')
    .meta({
      description:
        '分片格式：ts（MPEG-TS，兼容性最好，默认）或 fmp4（fMP4 / CMAF，每档多一个 720p_init.mp4 这样的初始化分片，新播放器和 DRM 方案更常用）',
    }),
});

export const hls = defineOperation({
  name: 'video.hls',
  route: '/api/video/hls',
  title: 'HLS 多码率切片',
  description:
    '把视频转成 HLS 自适应码率流：一次编码出多档清晰度（H.264 / AAC），生成主播放列表 master.m3u8、每档的播放列表和分片。',
  inputs: [fileInput('video', '要切片的视频')],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/video/hls \\',
    '  -F "file=@input.mp4" -F "renditions=1080,720,480" -F "segmentDuration=6"',
    '',
    '# URL 输入，fMP4 分片',
    'curl -X POST http://localhost:9527/api/video/hls \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","renditions":[720,360],"segmentType":"fmp4"}\'',
  ].join('\n'),
  notes: [
    '所有文件在同一个目录里，播放列表里都是相对路径：master.m3u8 引用 720p.m3u8 这样的分档列表，分档列表引用 720p_000.ts 这样的分片。上传到对象存储或静态服务器时保持目录结构即可直接播放。',
    '配置了 S3 对象存储且使用预签名链接（没有设置 S3_PUBLIC_BASE_URL）时，服务会把播放列表里的引用改写成各文件自己的签名链接后再上传，可以直接播放，但链接在 S3_PRESIGN_EXPIRES_SECONDS（默认 7 天）后失效；长期提供播放请设置 S3_PUBLIC_BASE_URL（公开读的桶或 CDN）。',
    '产物 files 是目录里的全部文件，主产物（primary）是 master.m3u8；任务结果 result 里有每档的名称、宽高、码率上限和播放列表文件名。',
    `清晰度按短边计算（竖屏视频 720 指宽 720），宽高按源画面比例取偶数；最多 ${MAX_RENDITIONS} 档，每档不超过 7680x4320（超出的档位跳过），帧率高于 60 的源降到 60。带旋转元数据的手机视频按摆正后的方向计算。`,
    '编码为 H.264（veryfast、CRF 23，按分辨率设码率上限）+ AAC 双声道；所有档位的关键帧都对齐到分片边界，播放器可以无缝切换清晰度。',
    `没有音轨的视频只输出画面；多音轨文件只用第一条音轨。每档最多 ${MAX_SEGMENTS} 个分片，超长视频请调大 segmentDuration。`,
  ],
  async run(ctx, p) {
    const source = await probeDisplay(ctx);
    const duration = source.media.duration;
    checkSegmentCount(duration, p.segmentDuration);
    const { renditions, dropped } = planRenditions(source, p.renditions);
    if (dropped.length > 0)
      ctx.log(`跳过的档位（高于源画面或超出 7680x4320）: ${dropped.join(', ')}`);
    const fps = outputFps(source);
    const hasAudio = Boolean(source.media.audio);

    const dir = await ctx.outputDir();
    const out = muxerDir(dir);
    const segmentExt = p.segmentType === 'fmp4' ? 'm4s' : 'ts';
    const args = [
      '-i',
      ctx.inputs.file[0],
      '-filter_complex',
      ladderFilter(renditions, fps, 'setsar=1'),
    ];
    renditions.forEach((_, i) => args.push('-map', `[v${i}]`));
    // 每档各自封装一路音频（muxed），老播放器和 Safari 都能直接播
    if (hasAudio) renditions.forEach(() => args.push('-map', '0:a:0'));
    args.push(...videoEncodeArgs(renditions, fps ?? (source.fps || 30), p.segmentDuration));
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', `${p.audioBitrate}k`, '-ac', '2');
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(p.segmentDuration),
      '-hls_playlist_type',
      'vod',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_type',
      p.segmentType === 'fmp4' ? 'fmp4' : 'mpegts',
    );
    if (p.segmentType === 'fmp4') {
      // 只有一档时 hls muxer 不替换 init 文件名里的 %v（8.1 / 9.0 都这样），直接写死档位名
      const init = renditions.length === 1 ? `${renditions[0].name}_init.mp4` : '%v_init.mp4';
      args.push('-hls_fmp4_init_filename', init);
    }
    const streamMap = renditions
      .map((r, i) => (hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
      .join(' ');
    args.push(
      '-hls_segment_filename',
      `${out}/%v_%03d.${segmentExt}`,
      '-master_pl_name',
      'master.m3u8',
      '-var_stream_map',
      streamMap,
      '-y',
      `${out}/%v.m3u8`,
    );

    ctx.log(`HLS 切片: ${renditions.map((r) => `${r.name} ${r.width}x${r.height}`).join(', ')}`);
    await ctx.ffmpeg(args, { duration });

    const files = await listFiles(dir);
    const master = path.join(dir, 'master.m3u8');
    if (!files.includes(master)) throw new Error('FFmpeg 没有生成 master.m3u8');
    return {
      files,
      primary: master,
      data: {
        master: 'master.m3u8',
        duration: round(duration, 3),
        segmentDuration: p.segmentDuration,
        segmentType: p.segmentType,
        audio: hasAudio,
        fileCount: files.length,
        renditions: renditions.map((r) => ({
          name: r.name,
          width: r.width,
          height: r.height,
          maxBitrate: `${r.maxrateKbps}k`,
          playlist: `${r.name}.m3u8`,
        })),
      },
    };
  },
});
