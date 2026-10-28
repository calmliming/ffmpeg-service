import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { hls } from '../../../../src/operations/analysis/hls';
import {
  checkSegmentCount,
  maxrateFor,
  planRenditions,
} from '../../../../src/operations/analysis/streaming';
import {
  parseFrameRate,
  videoFps,
  type DisplayVideo,
} from '../../../../src/operations/analysis/shared';
import { probeMedia, probeRaw } from '../../../../src/utils/media-probe';
import { runExpectingError } from './helpers';

let dir = '';
let video = '';
let silentVideo = '';
let rotated = '';
let audio = '';
let hfr = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-hls-');
  video = makeVideo(dir, 'video.mp4', { duration: 3 });
  silentVideo = makeVideo(dir, 'mute.mp4', { duration: 2, audio: false });
  // 编码画面 320x240，带 90 度旋转元数据（手机竖拍），播放时是 240x320
  rotated = path.join(dir, 'rotated.mp4');
  generate(['-display_rotation', '90', '-i', video, '-c', 'copy', rotated]);
  audio = makeAudio(dir, 'tone.wav', { duration: 1 });
  // 240 fps 的慢动作素材
  hfr = makeVideo(dir, 'hfr.mp4', { size: '256x144', rate: 240, duration: 1.2, audio: false });
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface HlsData {
  master: string;
  segmentType: string;
  audio: boolean;
  fileCount: number;
  renditions: { name: string; width: number; height: number; playlist: string }[];
}

const read = (file: string) => fs.readFileSync(file, 'utf8');
/** 播放列表里的 URI 行（不以 # 开头的非空行），以及 EXT-X-MAP 的 URI */
const uris = (playlist: string) => [
  ...playlist.split(/\r?\n/).filter((l) => l && !l.startsWith('#')),
  ...[...playlist.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]),
];
const extinf = (playlist: string) => [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => m[1]);

test('hls：两档清晰度，主播放列表和分片都用相对路径', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    hls,
    { file: [video] },
    { renditions: '240,144', segmentDuration: '2', audioBitrate: '96k' },
  );
  try {
    const data = result.data as HlsData;
    const outDir = path.dirname(result.files[0]);
    assert.equal(path.dirname(outDir), ctx.outputRoot);
    assert.ok(result.files.every((f) => path.dirname(f) === outDir));
    assert.equal(result.primary, path.join(outDir, 'master.m3u8'));
    assert.deepEqual(
      result.files.map((f) => path.basename(f)),
      [
        '144p.m3u8',
        '144p_000.ts',
        '144p_001.ts',
        '240p.m3u8',
        '240p_000.ts',
        '240p_001.ts',
        'master.m3u8',
      ],
    );
    assert.equal(data.fileCount, 7);
    assert.deepEqual(
      data.renditions.map((r) => [r.name, r.width, r.height, r.playlist]),
      [
        ['240p', 320, 240, '240p.m3u8'],
        ['144p', 192, 144, '144p.m3u8'],
      ],
    );

    const master = read(result.primary!);
    assert.deepEqual(uris(master), ['240p.m3u8', '144p.m3u8']);
    assert.match(master, /RESOLUTION=320x240,CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2"/);
    assert.match(master, /RESOLUTION=192x144/);
    const high = read(path.join(outDir, '240p.m3u8'));
    const low = read(path.join(outDir, '144p.m3u8'));
    assert.deepEqual(uris(high), ['240p_000.ts', '240p_001.ts']);
    assert.match(high, /#EXT-X-PLAYLIST-TYPE:VOD/);
    // 关键帧对齐到分片边界：两档的分片时长完全一致
    assert.deepEqual(extinf(high), ['2.000000', '1.000000']);
    assert.deepEqual(extinf(low), extinf(high));
    // 播放列表里不能出现本机绝对路径
    for (const text of [master, high, low]) assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\\/);

    const segment = await probeMedia(path.join(outDir, '144p_000.ts'));
    assert.equal(segment.video?.codec, 'h264');
    assert.equal(segment.video?.width, 192);
    assert.equal(segment.audio?.codec, 'aac');
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('hls：没有音轨的视频只切画面', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(hls, { file: [silentVideo] }, { segmentDuration: 2 });
  try {
    const data = result.data as HlsData;
    assert.equal(data.audio, false);
    // 默认档位：240p 源只有自己一档（更低的标准档 240 与源相同）
    assert.deepEqual(
      data.renditions.map((r) => r.name),
      ['240p'],
    );
    const master = read(result.primary!);
    assert.match(master, /CODECS="avc1\.[0-9a-f]+"/);
    assert.doesNotMatch(master, /mp4a/);
    const segment = await probeMedia(path.join(path.dirname(result.primary!), '240p_000.ts'));
    assert.equal(segment.audio, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('hls：竖拍视频按显示方向切片，高于源画面的档位被跳过', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(hls, { file: [rotated] }, { renditions: '1080,720' });
  try {
    const data = result.data as HlsData;
    assert.deepEqual(
      data.renditions.map((r) => [r.name, r.width, r.height]),
      [['240p', 240, 320]],
    );
    assert.ok(
      ctx.logs.some((l) => l.includes('跳过的档位（高于源画面或超出 7680x4320）: 1080, 720')),
    );
    const segment = await probeMedia(path.join(path.dirname(result.primary!), '240p_000.ts'));
    assert.equal(segment.video?.width, 240);
    assert.equal(segment.video?.height, 320);
  } finally {
    await ctx.cleanup();
  }
});

test('hls：fmp4 分片带 init 文件，单档也能正确命名', { skip: ffmpegSkip }, async () => {
  const single = await runOperation(
    hls,
    { file: [video] },
    { segmentType: 'fmp4', segmentDuration: 2 },
  );
  try {
    const names = single.result.files.map((f) => path.basename(f));
    assert.deepEqual(names, [
      '240p.m3u8',
      '240p_000.m4s',
      '240p_001.m4s',
      '240p_init.mp4',
      'master.m3u8',
    ]);
    const playlist = read(path.join(path.dirname(single.result.primary!), '240p.m3u8'));
    assert.match(playlist, /#EXT-X-MAP:URI="240p_init\.mp4"/);
    assert.equal((single.result.data as HlsData).segmentType, 'fmp4');
  } finally {
    await single.ctx.cleanup();
  }

  const multi = await runOperation(
    hls,
    { file: [video] },
    { segmentType: 'fmp4', renditions: [240, 144] },
  );
  try {
    const names = multi.result.files.map((f) => path.basename(f));
    assert.ok(names.includes('240p_init.mp4') && names.includes('144p_init.mp4'), String(names));
    assert.ok(!names.some((n) => n.includes('%')));
  } finally {
    await multi.ctx.cleanup();
  }
});

/** 分片里画面关键帧的时间点 */
function keyframeTimes(file: string): number[] {
  const out = execFileSync(
    config.ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  );
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => Number(line.replace(/,$/, '')));
}

test('hls：240 fps 的源降到 60 fps，每个分片只有开头一个关键帧', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(hls, { file: [hfr] }, { segmentDuration: 2 });
  try {
    const segment = path.join(path.dirname(result.primary!), '144p_000.ts');
    const raw = await probeRaw(segment);
    const stream = (raw.streams as { codec_type?: string; avg_frame_rate?: string }[]).find(
      (s) => s.codec_type === 'video',
    );
    assert.equal(stream?.avg_frame_rate, '60/1');
    // GOP 按 30 fps 算时 240 fps 的画面每 0.25 秒就有一个关键帧
    assert.equal(keyframeTimes(segment).length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('hls：纯音频文件直接失败', { skip: ffmpegSkip }, async () => {
  const { error, outputs } = await runExpectingError(hls, { file: [audio] });
  assert.match(error.message, /没有视频画面/);
  assert.deepEqual(outputs, []);
});

test('hls：参数校验', () => {
  const renditionsError =
    'renditions 必须是逗号分隔的清晰度列表，如 1080,720,480（每个 144-4320 的整数，最多 4 个）';
  assert.deepEqual(paramErrors(hls, { renditions: 'abc' }), [renditionsError]);
  assert.deepEqual(paramErrors(hls, { renditions: '100' }), [renditionsError]);
  assert.deepEqual(paramErrors(hls, { renditions: '1080,720,480,360,240' }), [renditionsError]);
  assert.deepEqual(paramErrors(hls, { segmentDuration: '1' }), [
    'segmentDuration 必须是 2 到 10 之间的整数',
  ]);
  assert.deepEqual(paramErrors(hls, { audioBitrate: '500k' }), [
    'audioBitrate 必须在 32k 到 320k 之间，如 128k',
  ]);
  assert.deepEqual(paramErrors(hls, { audioBitrate: 'loud' }), [
    'audioBitrate 必须是码率，如 128k、2M 或 800000',
  ]);
  assert.deepEqual(paramErrors(hls, { segmentType: 'mkv' }), ['segmentType 只能是 ts / fmp4']);
  assert.deepEqual(
    paramErrors(hls, { renditions: '720p, 480', segmentDuration: '4', audioBitrate: '0.16M' }),
    [],
  );
  const parsed = hls.params.parse({ renditions: '720p, 480', audioBitrate: '160000' });
  assert.deepEqual(parsed.renditions, [720, 480]);
  assert.equal(parsed.audioBitrate, 160);
  assert.equal(parsed.segmentDuration, 6);
});

const source = (width: number, height: number, fps = 30): DisplayVideo => ({
  media: { duration: 10 },
  width,
  height,
  fps,
});

test('hls：帧率解析接受高帧率，拒绝时间基；r_frame_rate 偏高时取平均帧率', () => {
  assert.equal(parseFrameRate('240/1'), 240);
  assert.equal(parseFrameRate('960'), 960);
  assert.ok(Math.abs(parseFrameRate('30000/1001') - 29.97) < 0.01);
  // mkv 的 1000/1、MPEG-TS 的 90000/1 是时间基，不是帧率
  assert.equal(parseFrameRate('1000/1'), 0);
  assert.equal(parseFrameRate('90000/1'), 0);
  assert.equal(parseFrameRate('0/0'), 0);
  const fps = (frameRate: string, avgFrameRate: string) =>
    videoFps({
      duration: 1,
      video: {
        codec: 'h264',
        profile: '',
        width: 320,
        height: 240,
        pixFmt: 'yuv420p',
        frameRate,
        avgFrameRate,
        duration: 1,
        rotation: 0,
        displayWidth: 320,
        displayHeight: 240,
        sar: '1:1',
      },
    });
  assert.equal(fps('240/1', '240/1'), 240);
  assert.equal(fps('240/1', '0/0'), 240);
  assert.equal(fps('1000/1', '30/1'), 30);
  // 隔行素材的 r_frame_rate 是场频
  assert.equal(fps('50/1', '25/1'), 25);
  // 240 fps 的源：码率上限按降到 60 fps 之后计算
  const planned = planRenditions(source(1920, 1080, 240), [1080]).renditions[0];
  assert.equal(planned.maxrateKbps, maxrateFor(1920, 1080, 60));
});

test('hls：planRenditions 的默认阶梯、竖屏、奇数尺寸', () => {
  const landscape = planRenditions(source(1920, 1080), undefined).renditions;
  assert.deepEqual(
    landscape.map((r) => [r.name, r.width, r.height]),
    [
      ['1080p', 1920, 1080],
      ['720p', 1280, 720],
      ['480p', 854, 480],
      ['360p', 640, 360],
    ],
  );
  const portrait = planRenditions(source(1080, 1920), [720, 2160]);
  assert.deepEqual(
    portrait.renditions.map((r) => [r.width, r.height]),
    [[720, 1280]],
  );
  assert.deepEqual(portrait.dropped, [2160]);
  // 奇数短边向下取偶数，不放大
  const odd = planRenditions(source(1279, 719), undefined).renditions;
  assert.deepEqual([odd[0].width, odd[0].height], [1278, 718]);
  assert.ok(odd.every((r) => r.width % 2 === 0 && r.height % 2 === 0));
  // 和源画面接近（90% 以上）的标准档跳过
  assert.deepEqual(
    planRenditions(source(1280, 700), undefined).renditions.map((r) => r.name),
    ['700p', '480p', '360p', '240p'],
  );
  // 超过 7680x4320 的档位丢掉：默认阶梯从 2160p 开始，只要 4320p 时直接失败
  const huge = planRenditions(source(16000, 9000), undefined);
  assert.deepEqual([huge.renditions[0].width, huge.renditions[0].height], [3840, 2160]);
  assert.deepEqual(huge.dropped, [9000]);
  assert.throws(() => planRenditions(source(20000, 9000), [4320]), /太大/);
  assert.ok(maxrateFor(1920, 1080, 60) > maxrateFor(1920, 1080, 30));
  assert.equal(maxrateFor(320, 240, 25), 300);
  assert.throws(() => checkSegmentCount(20000, 6), /超过上限 2000/);
  assert.doesNotThrow(() => checkSegmentCount(3600, 2));
});
