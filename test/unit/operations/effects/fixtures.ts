import { spawnSync } from 'node:child_process';
import { config } from '../../../../src/config';
import { probeRaw } from '../../../../src/utils/media-probe';

/**
 * 两个视频（可选同一个裁剪区域）的平均 PSNR（dB）。完全相同时 FFmpeg 给 inf，这里返回 Infinity。
 * 用来断言「区域内被改动、区域外保持原样」
 */
export function psnr(a: string, b: string, crop?: string): number {
  const pre = crop ? `crop=${crop},` : '';
  const graph = `[0:v]${pre}format=yuv420p[a];[1:v]${pre}format=yuv420p[b];[a][b]psnr`;
  const res = spawnSync(
    config.ffmpegPath,
    ['-hide_banner', '-nostdin', '-i', a, '-i', b, '-lavfi', graph, '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const match = /average:(inf|[\d.]+)/.exec(res.stderr);
  if (!match) throw new Error(`无法计算 PSNR: ${res.stderr.slice(-500)}`);
  return match[1] === 'inf' ? Infinity : Number(match[1]);
}

/** 第 n 帧的 signalstats 指标（YAVG 平均亮度、SATAVG 平均饱和度等） */
export function frameStats(file: string, frame = 10): Record<string, number> {
  const res = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${frame}),signalstats,metadata=mode=print`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const stats: Record<string, number> = {};
  for (const match of res.stderr.matchAll(/lavfi\.signalstats\.(\w+)=([-\d.]+)/g)) {
    stats[match[1]] = Number(match[2]);
  }
  if (Object.keys(stats).length === 0)
    throw new Error(`无法读取画面统计: ${res.stderr.slice(-500)}`);
  return stats;
}

/** 画面中央区域相邻帧差的平均亮度，越大表示画面运动（抖动）越剧烈 */
export function frameMotion(file: string): number {
  const res = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-vf',
      'crop=iw*5/8:ih*5/8:iw*3/16:ih*3/16,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const values = [...res.stderr.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  if (values.length === 0) throw new Error(`无法计算帧差: ${res.stderr.slice(-500)}`);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 第一条视频流全部数据包的 MD5，用来断言画面是流复制（逐字节相同）而不是重新编码 */
export function videoPacketsHash(file: string): string {
  const res = spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-c',
      'copy',
      '-f',
      'hash',
      '-hash',
      'md5',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const match = /MD5=([0-9a-f]+)/.exec(res.stdout);
  if (!match) throw new Error(`无法计算视频流哈希: ${res.stderr.slice(-500)}`);
  return match[1];
}

/** 渲染某一时刻的画面为 PNG，人工检查效果用 */
export function renderFrame(file: string, seconds: number, png: string): void {
  spawnSync(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds),
      '-i',
      file,
      '-frames:v',
      '1',
      '-update',
      '1',
      '-y',
      png,
    ],
    { encoding: 'utf8' },
  );
}

/** 第一条视频流的 codec_name 和 codec_tag_string，容器名 */
export async function streamInfo(
  file: string,
): Promise<{ videoCodec: string; videoTag: string; audioCodecs: string[]; format: string }> {
  const raw = (await probeRaw(file)) as {
    streams?: { codec_type?: string; codec_name?: string; codec_tag_string?: string }[];
    format?: { format_name?: string };
  };
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  return {
    videoCodec: video?.codec_name ?? '',
    videoTag: video?.codec_tag_string ?? '',
    audioCodecs: streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name ?? ''),
    format: raw.format?.format_name ?? '',
  };
}
