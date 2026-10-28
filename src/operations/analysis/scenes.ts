import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { booleanParam, numberParam } from '../../schemas/coerce';
import { decodedDuration } from '../audio/format';
import { defineOperation } from '../types';
import { fileInput, num, parseMetadataFrames, probeInput, readOptionalFile, round } from './shared';

/** 场景列表上限：频闪、噪点素材在低阈值下每帧都可能算切换 */
const MAX_SCENES = 5000;
const MAX_THUMBNAILS = 100;
/** 有缩略图时，检测这一遍占总进度的比例 */
const DETECT_SHARE = 0.8;

const params = z.object({
  threshold: numberParam('threshold', { min: 0.05, max: 0.95 }).default(0.3).meta({
    description:
      '切换灵敏度（0.05-0.95），前后两帧差异超过它算新场景，默认 0.3。越小越敏感，渐变转场多的素材可以调到 0.2',
  }),
  minInterval: numberParam('minInterval', { min: 0, max: 3600 }).default(0).meta({
    description:
      '两个切换点之间的最短间隔（秒，0-3600），用来过滤闪光、快速切换造成的碎片，默认 0（不过滤）',
  }),
  thumbnails: booleanParam('thumbnails')
    .default(false)
    .meta({
      description: `是否为每个场景的第一帧导出一张 jpg 缩略图（最多 ${MAX_THUMBNAILS} 张），默认 false`,
    }),
  thumbnailWidth: numberParam('thumbnailWidth', { min: 16, max: 1920, int: true })
    .default(320)
    .meta({ description: '缩略图宽度（像素，16-1920），高度按比例，默认 320；不会放大' }),
});

export interface Scene {
  index: number;
  start: number;
  end: number;
  duration: number;
  /** 切入这个场景时的画面差异（0-1）；第一个场景没有切换点，为 null */
  score: number | null;
  thumbnail?: string;
}

/** 切换点（时间 + 分数）→ 场景列表，第一个场景从 0 开始 */
export function buildScenes(cuts: { time: number; score: number }[], duration: number): Scene[] {
  const sorted = cuts.filter((c) => c.time > 0).sort((a, b) => a.time - b.time);
  const end = Math.max(duration, sorted.at(-1)?.time ?? 0);
  const starts = [{ time: 0, score: null as number | null }, ...sorted];
  return starts.map((cut, i) => {
    const next = i + 1 < starts.length ? starts[i + 1].time : end;
    return {
      index: i,
      start: round(cut.time, 3),
      end: round(next, 3),
      duration: round(next - cut.time, 3),
      score: cut.score === null ? null : round(cut.score, 4),
    };
  });
}

/**
 * 检测用的滤镜图。select 会丢掉非切换帧，单独一路输出时 -progress 的 out_time 只在切换点前进，
 * 所以 split 出一路完整画面给 null 输出汇报进度，检测分支写完元数据后进 nullsink
 */
export function detectFilter(threshold: number, minInterval: number): string {
  // prev_selected_t 在第一个切换点之前是 NaN，此时按离开头的距离算间隔
  const gap = 't-if(isnan(prev_selected_t),0,prev_selected_t)';
  const select = `select='gt(scene,${num(threshold)})*gte(${gap},${num(minInterval)})'`;
  return `[0:v:0]split=2[scan][pass];[scan]${select},metadata=mode=print:file=scenes.txt,nullsink`;
}

export const scenes = defineOperation({
  name: 'analyze.scenes',
  route: '/api/analyze/scenes',
  title: '场景切换检测',
  description: '找出视频里的镜头切换点，把视频分成一个个场景，可选为每个场景导出缩略图。',
  inputs: [fileInput('video', '要分析的视频')],
  params,
  example: [
    'curl -X POST http://localhost:9527/api/analyze/scenes \\',
    '  -F "file=@input.mp4" -F "threshold=0.3" -F "thumbnails=true"',
    '',
    '# URL 输入，过滤 1 秒内的连续切换',
    'curl -X POST http://localhost:9527/api/analyze/scenes \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","minInterval":1}\'',
  ].join('\n'),
  notes: [
    '结果：scenes（[{ index, start, end, duration, score, thumbnail? }]，秒）和 sceneCount。score 是切入该场景时前后两帧的差异（0-1），第一个场景为 null。',
    'minInterval 从视频开头算起：离开头或上一个切换点不到 minInterval 秒的切换点会被忽略。',
    `thumbnails=true 时每个场景第一帧导出一张 jpg（scene_001.jpg 起编号，宽度默认 320），最多 ${MAX_THUMBNAILS} 张，超过时只导出前 ${MAX_THUMBNAILS} 个场景并把 thumbnailsTruncated 设为 true；scenes[i].thumbnail 是对应的文件名，产物 files 是全部缩略图。`,
    `场景最多返回 ${MAX_SCENES} 个，超过时 truncated 为 true（sceneCount 仍是实际数量）。`,
    '检测要解码整段视频，耗时和视频长度、分辨率成正比；渐变（淡入淡出、叠化）转场的差异分数较低，可能需要调小 threshold。只分析第一路画面，没有画面的文件直接失败。',
    '没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录屏）按实际解码长度计算 duration 和最后一个场景的结尾。',
  ],
  async run(ctx, p) {
    const media = await probeInput(ctx, 'video');
    const input = ctx.inputs.file[0];
    const probed = media.video?.duration || media.duration;

    const { stderr } = await ctx.ffmpeg(
      [
        '-i',
        input,
        '-filter_complex',
        detectFilter(p.threshold, p.minInterval),
        '-map',
        '[pass]',
        '-fps_mode',
        'passthrough',
        '-f',
        'null',
        '-',
      ],
      {
        duration: probed,
        range: [0, p.thumbnails ? DETECT_SHARE : 1],
        logLevel: 'info',
        captureStderr: true,
      },
    );
    // 容器里没有时长（管道写出的 webm、浏览器 MediaRecorder 录屏）时最后一个场景要靠实际解码长度收尾
    const duration = Math.max(probed, decodedDuration(stderr) ?? 0);

    const cuts = parseMetadataFrames(await readOptionalFile(ctx.tempPath('scenes.txt'))).map(
      (f) => ({ time: f.time, score: Number(f.values.get('lavfi.scene_score') ?? 0) || 0 }),
    );
    const all = buildScenes(cuts, duration);
    const list = all.slice(0, MAX_SCENES);
    const files: string[] = [];

    if (p.thumbnails) {
      // 和检测分开做：同一条命令里加图片输出后 -progress 只跟着图片输出走，长视频会长时间停在 0
      const dir = await ctx.outputDir();
      const count = Math.min(list.length, MAX_THUMBNAILS);
      const span = 1 - DETECT_SHARE;
      for (let i = 0; i < count; i++) {
        const scene = list[i];
        const name = `scene_${String(i + 1).padStart(3, '0')}.jpg`;
        const output = path.join(dir, name);
        // 精确定位会丢掉时间戳小于 -ss 的帧，往前让 1 毫秒，避免浮点误差把切换后的第一帧也丢掉
        const seek = scene.start > 0 ? ['-ss', num(Math.max(0, scene.start - 0.001))] : [];
        const range: [number, number] = [
          DETECT_SHARE + (span * i) / count,
          DETECT_SHARE + (span * (i + 1)) / count,
        ];
        try {
          await ctx.ffmpeg(
            [
              ...seek,
              '-i',
              input,
              '-map',
              '0:v:0',
              '-frames:v',
              '1',
              '-vf',
              `scale='min(${p.thumbnailWidth},iw)':-2`,
              '-q:v',
              '3',
              '-update',
              '1',
              '-f',
              'image2',
              '-y',
              output,
            ],
            { range },
          );
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          // 切换点落在最后一帧附近时定位可能取不到画面，缺一张缩略图不影响分析结果
          const reason = err instanceof Error ? err.message : String(err);
          ctx.log(`场景 ${i + 1} 的缩略图生成失败: ${reason}`);
        }
        if (fs.existsSync(output)) {
          scene.thumbnail = name;
          files.push(output);
        }
      }
    }

    return {
      files,
      data: {
        duration: round(duration, 3),
        threshold: p.threshold,
        minInterval: p.minInterval,
        sceneCount: all.length,
        scenes: list,
        truncated: all.length > MAX_SCENES,
        ...(p.thumbnails ? { thumbnailsTruncated: list.length > MAX_THUMBNAILS } : {}),
      },
    };
  },
});
