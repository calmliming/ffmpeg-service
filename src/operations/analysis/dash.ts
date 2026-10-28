import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { booleanParam } from '../../schemas/coerce';
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
      description: `清晰度列表（短边像素，横屏即高度），逗号分隔，如 1080,720,480，最多 ${MAX_RENDITIONS} 档。默认：源画面一档加上更低的标准档。高于源画面的档位会被丢掉，不放大`,
    }),
  segmentDuration: segmentDurationParam(4).meta({
    description: '每个分片的时长（秒，2-10 的整数），默认 4',
  }),
  audioBitrate: audioBitrateParam().meta({
    description: 'AAC 音频码率，32k-320k，默认 128k',
  }),
  hlsPlaylist: booleanParam('hlsPlaylist').default(false).meta({
    description:
      '是否同时生成引用同一批 fMP4 分片的 HLS 播放列表（master.m3u8），一份分片同时支持 DASH 和 HLS 播放器，默认 false',
  }),
});

/** 最大公约数，用来把显示比例约成 16/9 这样的整数比 */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * dashenc 的 SegmentList 固定写 startNumber="1"。规范里它只是第一个分片的编号，dash.js、Shaka、ExoPlayer 都按列表顺序取分片；
 * 但 FFmpeg 自己的 DASH 解复用器（ffplay、mpv 也用它）把 startNumber 当成列表下标，会跳过第一个分片。改成 0 两边都能完整播放
 */
export function zeroStartNumber(mpd: string): string {
  return mpd.replace(/(<SegmentList\b[^>]*?\bstartNumber=")1"/g, (_, head: string) => `${head}0"`);
}

export const dash = defineOperation({
  name: 'video.dash',
  route: '/api/video/dash',
  title: 'DASH 多码率切片',
  description:
    '把视频转成 MPEG-DASH 自适应码率流：一次编码出多档清晰度（H.264 / AAC，fMP4 分片），生成 manifest.mpd；可选同时生成 HLS 播放列表。',
  inputs: [fileInput('video', '要切片的视频')],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/video/dash \\',
    '  -F "file=@input.mp4" -F "renditions=1080,720,360"',
    '',
    '# URL 输入，同时生成 HLS 播放列表',
    'curl -X POST http://localhost:9527/api/video/dash \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","hlsPlaylist":true}\'',
  ].join('\n'),
  notes: [
    '所有文件在同一个目录里，manifest.mpd 用 SegmentList 逐个列出每档的初始化分片和媒体分片（init-stream0.m4s、chunk-stream0-00001.m4s…，相对路径，标称时长为 segmentDuration）；保持目录结构上传即可播放（dash.js、Shaka Player、ExoPlayer）。不用 SegmentTemplate 模板，所以对象存储预签名模式下每个引用都能换成各自的签名 URL。',
    '预签名链接在 S3_PRESIGN_EXPIRES_SECONDS（默认 7 天）后失效；长期提供播放请设置 S3_PUBLIC_BASE_URL（公开读的桶或 CDN）。',
    '产物 files 是目录里的全部文件，主产物（primary）是 manifest.mpd；hlsPlaylist=true 时目录里还有 master.m3u8 和 media_N.m3u8。',
    '画面各档放在一个 AdaptationSet、音频单独一个 AdaptationSet（所有档共用一路音频）；为满足 DASH 同一 AdaptationSet 画面比例必须一致的要求，各档统一设置显示比例，像素宽高比可能不是 1:1。',
    `清晰度按短边计算，最多 ${MAX_RENDITIONS} 档，每档不超过 7680x4320，帧率高于 60 的源降到 60；关键帧对齐到分片边界。没有音轨的视频只输出画面。每档最多 ${MAX_SEGMENTS} 个分片。`,
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

    const top = renditions[0];
    const divisor = gcd(top.width, top.height);
    const dar = `setdar=${top.width / divisor}/${top.height / divisor}`;

    const dir = await ctx.outputDir();
    const out = muxerDir(dir);
    const args = ['-i', ctx.inputs.file[0], '-filter_complex', ladderFilter(renditions, fps, dar)];
    renditions.forEach((_, i) => args.push('-map', `[v${i}]`));
    if (hasAudio) args.push('-map', '0:a:0');
    args.push(...videoEncodeArgs(renditions, fps ?? (source.fps || 30), p.segmentDuration));
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', `${p.audioBitrate}k`, '-ac', '2');
    args.push(
      '-f',
      'dash',
      '-seg_duration',
      String(p.segmentDuration),
      // SegmentList 逐个写出 init 和每个分片的文件名，不用 SegmentTemplate 的 $Number$ 模板：
      // 对象存储预签名模式下每个文件的签名 URL 各不相同，只有逐个列出的引用才能一一替换
      '-use_template',
      '0',
      '-use_timeline',
      '0',
      '-adaptation_sets',
      hasAudio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
    );
    if (p.hlsPlaylist) args.push('-hls_playlist', '1', '-hls_master_name', 'master.m3u8');
    args.push('-y', `${out}/manifest.mpd`);

    ctx.log(`DASH 切片: ${renditions.map((r) => `${r.name} ${r.width}x${r.height}`).join(', ')}`);
    await ctx.ffmpeg(args, { duration });

    const files = await listFiles(dir);
    const manifest = path.join(dir, 'manifest.mpd');
    if (!files.includes(manifest)) throw new Error('FFmpeg 没有生成 manifest.mpd');
    const mpd = await fs.promises.readFile(manifest, 'utf8');
    await fs.promises.writeFile(manifest, zeroStartNumber(mpd));
    return {
      files,
      primary: manifest,
      data: {
        manifest: 'manifest.mpd',
        ...(p.hlsPlaylist ? { hlsMaster: 'master.m3u8' } : {}),
        duration: round(duration, 3),
        segmentDuration: p.segmentDuration,
        audio: hasAudio,
        fileCount: files.length,
        renditions: renditions.map((r, i) => ({
          name: r.name,
          representationId: String(i),
          width: r.width,
          height: r.height,
          maxBitrate: `${r.maxrateKbps}k`,
        })),
      },
    };
  },
});
