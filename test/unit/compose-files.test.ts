import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config';
import { composeFiles } from '../../src/services/compose.service';
import { probeMedia } from '../../src/utils/media-probe';
import { makeHalfVideo, regionLuma } from './operations/timeline/helpers';

// 用 ffmpeg 现场生成小素材跑真实的合成命令，机器上没有 ffmpeg 时整组跳过
function ffmpegAvailable(): boolean {
  try {
    execFileSync(config.ffmpegPath, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const skip = ffmpegAvailable() ? false : 'ffmpeg 不可用';

let dir = '';
let workDir = '';
const clip = (name: string) => path.join(dir, name);

function generate(args: string[]) {
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args, '-y'], {
    stdio: 'pipe',
  });
}

function makeClip(
  name: string,
  opts: { size: string; rate: number; audio: boolean; freq?: number },
) {
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${opts.size}:rate=${opts.rate}:duration=2`];
  if (opts.audio) {
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${opts.freq ?? 440}:sample_rate=48000:duration=2`,
    );
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (opts.audio) args.push('-c:a', 'aac', '-ac', '2', '-shortest');
  args.push(clip(name));
  generate(args);
}

before(async () => {
  if (skip) return;
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ffsvc-compose-'));
  workDir = path.join(dir, 'work');
  await fs.promises.mkdir(workDir);
  makeClip('a.mp4', { size: '1280x720', rate: 24, audio: true, freq: 440 });
  makeClip('b.mp4', { size: '1280x720', rate: 24, audio: true, freq: 660 });
  makeClip('silent.mp4', { size: '1280x720', rate: 24, audio: false });
  makeClip('small.mp4', { size: '640x360', rate: 30, audio: true });
  generate([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=44100:duration=1',
    clip('short.wav'),
  ]);
  fs.writeFileSync(clip('broken.mp4'), 'not a video');
  // 左白右黑的横屏画面；rot.mp4 存法相同但带 90 度旋转信息（手机竖拍），
  // 播放时逆时针转正成 180x320，左半边的白色转到下半部分
  makeHalfVideo(dir, 'half.mp4');
  makeHalfVideo(dir, 'rot.mp4', { rotation: 90 });
  // 存储 320x240、SAR 4:3 的纯白画面，显示成 16:9（与 half.mp4 比例相同）
  generate([
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=320x240:r=25:d=1,setsar=4/3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-shortest',
    clip('anamorphic.mp4'),
  ]);
});

const top = { x: 0, y: 0, w: 1, h: 0.25 };
const bottom = { x: 0, y: 0.75, w: 1, h: 0.25 };

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

let seq = 0;
async function compose(videos: string[], extra: { music?: string; mute?: boolean } = {}) {
  const output = path.join(dir, `out-${++seq}.mp4`);
  const stages: string[] = [];
  const fractions: number[] = [];
  const result = await composeFiles({
    videoFiles: videos.map(clip),
    musicFile: extra.music && clip(extra.music),
    musicVolume: 0.8,
    muteOriginalAudio: extra.mute ?? false,
    output,
    workDir,
    prefix: `case${seq}`,
    onStage: (s) => stages.push(s),
    onProgress: (f) => fractions.push(f),
  });
  const info = await probeMedia(output);
  return { result, info, stages, fractions, output };
}

function assertDuration(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.3, `时长 ${actual}s，期望约 ${expected}s`);
}

test('composeFiles：参数一致时直接流复制，时长等于片段之和', { skip }, async () => {
  const { result, info, stages } = await compose(['a.mp4', 'b.mp4']);
  assert.equal(result.normalized, false);
  assert.deepEqual(stages, ['merging']);
  assertDuration(info.duration, 4);
  assert.ok(info.audio);
});

test('composeFiles：消除原声且音乐比视频短时不截断视频', { skip }, async () => {
  const { info } = await compose(['a.mp4', 'b.mp4'], { music: 'short.wav', mute: true });
  assertDuration(info.duration, 4);
  assert.ok(info.audio);
});

test('composeFiles：混音且音乐比视频短时输出仍是视频总长', { skip }, async () => {
  const { info } = await compose(['a.mp4', 'b.mp4'], { music: 'short.wav' });
  assertDuration(info.duration, 4);
  assert.ok(info.audio);
});

test('composeFiles：有片段缺音轨时先统一转码并补静音', { skip }, async () => {
  const { result, info, stages, fractions } = await compose(['a.mp4', 'silent.mp4', 'b.mp4']);
  assert.equal(result.normalized, true);
  assert.match(result.reasons.join(), /无音轨/);
  assert.deepEqual(stages, ['normalizing', 'merging']);
  assertDuration(info.duration, 6);
  assert.ok(info.audio);
  assert.ok(
    fractions.every((f, i) => i === 0 || f >= fractions[i - 1]),
    '进度不应倒退',
  );
});

test('composeFiles：分辨率帧率不同时统一成第 1 个视频的参数', { skip }, async () => {
  const { result, info } = await compose(['a.mp4', 'small.mp4']);
  assert.equal(result.normalized, true);
  assert.equal(info.video?.width, 1280);
  assert.equal(info.video?.height, 720);
  assert.equal(info.video?.frameRate, '24/1');
  assertDuration(info.duration, 4);
});

test(
  'composeFiles：竖拍（带旋转）在前时按转正后的竖屏尺寸统一，横屏片段不会被转歪',
  { skip },
  async () => {
    const { result, info, output } = await compose(['rot.mp4', 'half.mp4']);
    assert.equal(result.normalized, true);
    assert.match(result.reasons.join(), /旋转 90°/);
    assert.equal(info.video?.width, 180);
    assert.equal(info.video?.height, 320);
    assert.equal(info.video?.rotation, 0);
    assertDuration(info.duration, 2);
    // 第 1 段转正：上半黑、下半白
    assert.ok(regionLuma(output, 0.5, top) < 30, '第 1 段上方应是黑色');
    assert.ok(regionLuma(output, 0.5, bottom) > 220, '第 1 段下方应是白色');
    // 第 2 段是横屏：缩小后上下补黑边，中间仍是左白右黑
    assert.ok(regionLuma(output, 1.5, top) < 30, '第 2 段上方应是黑边');
    assert.ok(regionLuma(output, 1.5, bottom) < 30, '第 2 段下方应是黑边，不是转歪的画面');
    assert.ok(
      regionLuma(output, 1.5, { x: 0.05, y: 0.45, w: 0.4, h: 0.1 }) > 220,
      '第 2 段中间左侧应是白色',
    );
    assert.ok(
      regionLuma(output, 1.5, { x: 0.55, y: 0.45, w: 0.4, h: 0.1 }) < 30,
      '第 2 段中间右侧应是黑色',
    );
  },
);

test('composeFiles：横屏在前时竖拍片段转正后左右补黑边', { skip }, async () => {
  const { result, info, output } = await compose(['half.mp4', 'rot.mp4']);
  assert.equal(result.normalized, true);
  assert.equal(info.video?.width, 320);
  assert.equal(info.video?.height, 180);
  assert.equal(info.video?.rotation, 0);
  // 第 2 段转正后是竖屏：左右两侧是黑边，中间一列上黑下白
  assert.ok(regionLuma(output, 1.5, { x: 0, y: 0, w: 0.25, h: 1 }) < 30, '第 2 段左侧应是黑边');
  assert.ok(regionLuma(output, 1.5, { x: 0.75, y: 0, w: 0.25, h: 1 }) < 30, '第 2 段右侧应是黑边');
  assert.ok(
    regionLuma(output, 1.5, { x: 0.4, y: 0, w: 0.2, h: 0.3 }) < 30,
    '第 2 段中间上方应是黑色',
  );
  assert.ok(
    regionLuma(output, 1.5, { x: 0.4, y: 0.7, w: 0.2, h: 0.3 }) > 220,
    '第 2 段中间下方应是白色',
  );
});

test('composeFiles：旋转角度一致的片段仍直接流复制，保留旋转信息', { skip }, async () => {
  const { result, info, output } = await compose(['rot.mp4', 'rot.mp4']);
  assert.equal(result.normalized, false);
  assert.equal(info.video?.rotation, 90);
  assert.equal(info.video?.displayWidth, 180);
  assert.ok(regionLuma(output, 1.5, bottom) > 220, '第 2 段下方应是白色');
});

test('composeFiles：统一转码时非方形像素的片段按显示比例缩放，不变形', { skip }, async () => {
  const { result, output } = await compose(['half.mp4', 'anamorphic.mp4']);
  assert.equal(result.normalized, true);
  // 显示比例 16:9 与画布相同，应铺满画面；按存储宽高（4:3）算会在左右补黑边
  const left = regionLuma(output, 1.5, { x: 0, y: 0, w: 0.1, h: 1 });
  assert.ok(left > 220, `第 2 段左侧应是画面而不是黑边: ${left}`);
});

test('composeFiles：消除原声且无音乐时输出无音轨，缺音轨的片段不触发转码', { skip }, async () => {
  const { result, info } = await compose(['a.mp4', 'silent.mp4'], { mute: true });
  assert.equal(result.normalized, false);
  assert.equal(info.audio, undefined);
  assertDuration(info.duration, 4);
});

test('composeFiles：片段无法解析时报出序号，且不留下输出和中间文件', { skip }, async () => {
  const output = path.join(dir, 'broken-out.mp4');
  await assert.rejects(
    composeFiles({
      videoFiles: [clip('a.mp4'), clip('broken.mp4')],
      musicVolume: 1,
      muteOriginalAudio: false,
      output,
      workDir,
      prefix: 'broken',
    }),
    /第 2 个视频无法解析/,
  );
  assert.equal(fs.existsSync(output), false);
});

test('composeFiles：结束后工作目录里不残留中间文件', { skip }, async () => {
  assert.deepEqual(await fs.promises.readdir(workDir), []);
});
