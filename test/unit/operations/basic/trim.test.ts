import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trim } from '../../../../src/operations/basic/trim';
import { lastKeyframeBefore } from '../../../../src/operations/basic/probe';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import {
  TS_H264,
  assertInside,
  assertNear,
  countFrames,
  expectRunError,
  extOf,
  facts,
  frameLuma,
  makeRamp,
} from './helpers';

let dir = '';
let video = '';
let silent = '';
let rampTs = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-basic-trim-');
  video = makeVideo(dir, 'in.mp4', { duration: 3 });
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
  rampTs = makeRamp(dir, 'ramp.ts', TS_H264);
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('trim: startTime + duration 精确截取，保留容器和编码', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trim,
    { file: [video] },
    { startTime: '00:00:00.5', duration: '1.2' },
  );
  try {
    const [out] = result.files;
    assertInside(ctx.outputRoot, out);
    assert.equal(extOf(out), 'mp4');
    const f = await facts(out);
    assert.equal(f.video?.codec, 'h264');
    assert.equal(f.video?.width, 320);
    assert.equal(f.audio?.codec, 'aac');
    assertNear(f.duration, 1.2, 0.1);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test(
  'trim: endTime 是绝对时间点，与 duration 同时给时以 endTime 为准',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      trim,
      { file: [video] },
      { startTime: '1', endTime: '0:02', duration: '0.3' },
    );
    try {
      assertNear((await facts(result.files[0])).duration, 1, 0.1);
    } finally {
      await ctx.cleanup();
    }
  },
);

test(
  'trim: 只给 startTime 截到结尾，endTime 超过时长也截到结尾',
  { skip: ffmpegSkip },
  async () => {
    for (const raw of [{ startTime: 2 }, { startTime: 2, endTime: 100 }]) {
      const { result, ctx } = await runOperation(trim, { file: [video] }, raw);
      try {
        assertNear((await facts(result.files[0])).duration, 1, 0.1);
      } finally {
        await ctx.cleanup();
      }
    }
  },
);

test('trim: accurate=false 直接复制流', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trim,
    { file: [video] },
    { startTime: '0', duration: '1', accurate: 'false' },
  );
  try {
    const f = await facts(result.files[0]);
    assert.equal(extOf(result.files[0]), 'mp4');
    assert.equal(f.video?.codec, 'h264');
    assert.equal(f.audio?.codec, 'aac');
    assertNear(f.duration, 1, 0.15);
  } finally {
    await ctx.cleanup();
  }
});

test('trim: 没有音轨的视频输出也没有音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(trim, { file: [silent] }, { startTime: 0.5 });
  try {
    const f = await facts(result.files[0]);
    assert.ok(f.video);
    assert.equal(f.audio, undefined);
    assertNear(f.duration, 1.5, 0.1);
  } finally {
    await ctx.cleanup();
  }
});

test('trim: 纯音频输入保持音频容器', { skip: ffmpegSkip }, async () => {
  const cases: [string, string, string][] = [
    ['tone.mp3', 'mp3', 'mp3'],
    ['tone.wav', 'wav', 'pcm_s16le'],
    ['tone.flac', 'flac', 'flac'],
    ['tone.m4a', 'm4a', 'aac'],
  ];
  for (const [name, ext, codec] of cases) {
    const input = makeAudio(dir, name);
    for (const accurate of [true, false]) {
      const { result, ctx } = await runOperation(
        trim,
        { file: [input] },
        { startTime: 0.5, duration: 1, accurate },
      );
      try {
        assert.equal(extOf(result.files[0]), ext, `${name} accurate=${accurate}`);
        const f = await facts(result.files[0]);
        assert.equal(f.video, undefined);
        assert.equal(f.audio?.codec, codec);
        assertNear(f.duration, 1, 0.1);
      } finally {
        await ctx.cleanup();
      }
    }
  }
});

test('trim: 输出格式按 ffprobe 判断，不看扩展名', { skip: ffmpegSkip }, async () => {
  // 以 URL 提交时文件名可能没有扩展名或扩展名不对
  const noExt = path.join(dir, 'download');
  fs.copyFileSync(video, noExt);
  const webm = path.join(dir, 'clip.bin');
  generate([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=25:duration=2',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-f',
    'webm',
    webm,
  ]);
  // QuickTime 文件改名成 .mp4：major_brand 是 "qt  "，按 mov 输出（ProRes 之类只有 mov 装得下）
  const qt = path.join(dir, 'camera.mp4');
  generate(['-i', video, '-c', 'copy', '-f', 'mov', qt]);
  const cases: [string, string, string][] = [
    [noExt, 'mp4', 'h264'],
    [webm, 'mkv', 'vp9'],
    [qt, 'mov', 'h264'],
  ];
  for (const [input, ext, codec] of cases) {
    const { result, ctx } = await runOperation(
      trim,
      { file: [input] },
      { startTime: 0.5, accurate: false },
    );
    try {
      assert.equal(extOf(result.files[0]), ext, input);
      assert.equal((await facts(result.files[0])).video?.codec, codec);
    } finally {
      await ctx.cleanup();
    }
  }
});

test(
  'trim: 白名单外的格式重新编码输出 mp4，流复制挑能装下的容器',
  { skip: ffmpegSkip },
  async () => {
    const wmv = path.join(dir, 'clip.wmv');
    generate(['-i', video, '-t', '2', '-c:v', 'wmv2', '-c:a', 'wmav2', wmv]);
    const accurate = await runOperation(trim, { file: [wmv] }, { startTime: 0.5, duration: 1 });
    const copy = await runOperation(
      trim,
      { file: [wmv] },
      { startTime: 0.5, duration: 1, accurate: false },
    );
    try {
      assert.equal(extOf(accurate.result.files[0]), 'mp4');
      const a = await facts(accurate.result.files[0]);
      assert.equal(a.video?.codec, 'h264');
      assert.equal(a.audio?.codec, 'aac');
      assert.equal(extOf(copy.result.files[0]), 'mkv');
      const c = await facts(copy.result.files[0]);
      assert.equal(c.video?.codec, 'wmv2');
      assert.equal(c.audio?.codec, 'wmav2');
    } finally {
      await accurate.ctx.cleanup();
      await copy.ctx.cleanup();
    }
  },
);

test(
  'trim: MPEG-TS 输入从请求的时间点开始，画面完整（不会跳到下一个关键帧）',
  { skip: ffmpegSkip },
  async () => {
    // 关键帧在 0 / 2 / 4 / 6 / 8 秒附近。直接输入端跳转会落在关键帧之后：5.3 秒起的 2 秒只剩 32 帧、从 6 秒开始，
    // 8.5 秒起截到结尾则整段没有画面
    const cases: [number, number | undefined, number][] = [
      [5.3, 2, 50],
      [2.4, 1, 25],
      [8.5, undefined, 38],
    ];
    for (const [startTime, duration, frames] of cases) {
      const raw = duration === undefined ? { startTime } : { startTime, duration };
      const { result, ctx } = await runOperation(trim, { file: [rampTs] }, raw);
      try {
        const [out] = result.files;
        assert.equal(extOf(out), 'ts');
        const n = countFrames(out);
        assert.ok(Math.abs(n - frames) <= 1, `${startTime} 秒起：${n} 帧，预期 ${frames}`);
        assertNear(
          frameLuma(out),
          frameLuma(rampTs, startTime),
          3,
          `${startTime} 秒起的第一帧亮度`,
        );
        assert.ok((await facts(out)).audio, '音轨保留');
      } finally {
        await ctx.cleanup();
      }
    }
  },
);

test('trim: MPEG-TS 流复制从起点之前的关键帧开始', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    trim,
    { file: [rampTs] },
    { startTime: 5.3, duration: 2, accurate: false },
  );
  try {
    const [out] = result.files;
    // 起点之前的关键帧在 4.02 秒；以前从 6 秒的关键帧开始，开头缺了 0.7 秒
    assertNear(frameLuma(out), frameLuma(rampTs, 4.02), 3, '第一帧应是 4 秒处的关键帧');
    const n = countFrames(out);
    assert.ok(n >= 80, `应覆盖 4.02 到 7.3 秒（约 82 帧），实际 ${n} 帧`);
  } finally {
    await ctx.cleanup();
  }
});

test('trim: MPEG-PS（mpg）输入同样精确到帧', { skip: ffmpegSkip }, async () => {
  const mpg = makeRamp(dir, 'ramp.mpg', [
    '-c:v',
    'mpeg2video',
    '-bf',
    '2',
    '-sc_threshold',
    '1000000000',
    '-q:v',
    '4',
    '-c:a',
    'mp2',
    '-f',
    'mpeg',
  ]);
  const { result, ctx } = await runOperation(
    trim,
    { file: [mpg] },
    { startTime: 5.3, duration: 1 },
  );
  try {
    const [out] = result.files;
    assert.equal(extOf(out), 'mpg');
    const n = countFrames(out);
    assert.ok(Math.abs(n - 25) <= 1, `${n} 帧，预期 25`);
    assertNear(frameLuma(out), frameLuma(mpg, 5.3), 3, '第一帧亮度');
  } finally {
    await ctx.cleanup();
  }
});

test('trim: 解不出画面时任务失败，不返回只有声音的文件', { skip: ffmpegSkip }, async () => {
  // 去掉所有 IDR 帧：容器里有视频流，但一帧也解不出来，ffmpeg 照样以 0 退出、只写出音轨
  const broken = path.join(dir, 'no-idr.ts');
  generate([
    '-i',
    rampTs,
    '-map',
    '0',
    '-c',
    'copy',
    '-bsf:v',
    'filter_units=remove_types=5',
    '-f',
    'mpegts',
    broken,
  ]);
  for (const accurate of [true, false]) {
    await expectRunError(
      trim,
      { file: [broken] },
      { startTime: 1, duration: 2, accurate },
      /截取结果没有画面/,
    );
  }
});

test('lastKeyframeBefore: 显示时间不晚于目标的最后一个关键帧，没有 pts 时按 dts 保守估计', () => {
  const rows = [
    { pts_time: '1.480000', dts_time: '1.400000', flags: 'K__' },
    { pts_time: '2.000000', dts_time: '1.440000', flags: '___' },
    { pts_time: '3.480000', dts_time: '3.400000', flags: 'K__' },
    { dts_time: '5.400000', flags: 'K__' },
    { pts_time: '9.000000', dts_time: '8.900000', flags: '___' },
  ];
  assert.equal(lastKeyframeBefore(rows, 1), undefined);
  assert.equal(lastKeyframeBefore(rows, 3), 1.4);
  assert.equal(lastKeyframeBefore(rows, 3.48), 3.4);
  // 5.4 只有 dts，显示时间可能晚到 6.4，目标 6 秒时不能选它
  assert.equal(lastKeyframeBefore(rows, 6), 3.4);
  assert.equal(lastKeyframeBefore(rows, 6.5), 5.4);
  assert.equal(lastKeyframeBefore([{ pts_time: 'N/A', flags: 'K__' }], 6), undefined);
});

test('trim: 起点超出时长时给出中文错误', { skip: ffmpegSkip }, async () => {
  await expectRunError(
    trim,
    { file: [video] },
    { startTime: '00:00:05' },
    /startTime（5 秒）超出了媒体时长/,
  );
});

test('trim: 参数校验', () => {
  const one = (raw: Record<string, unknown>) => paramErrors(trim, raw).join(' | ');
  assert.match(one({}), /请提供 startTime 参数/);
  assert.match(one({ startTime: '  ' }), /请提供 startTime 参数/);
  assert.match(one({ startTime: 'abc' }), /startTime 必须是秒数或 HH:MM:SS 格式的时间/);
  assert.match(one({ startTime: '-3' }), /startTime 必须是秒数或 HH:MM:SS/);
  assert.match(one({ startTime: 5, endTime: '00:00:05' }), /endTime 必须大于 startTime/);
  assert.match(one({ startTime: 5, endTime: 2 }), /endTime 必须大于 startTime/);
  assert.match(one({ startTime: 0, duration: 0 }), /duration 必须大于 0/);
  assert.match(one({ startTime: 0, duration: '1:99' }), /duration 必须是秒数或 HH:MM:SS/);
  assert.match(one({ startTime: 0, accurate: 'nah' }), /accurate 必须是布尔值/);
  assert.match(one({ startTime: 0, accurate: false, crf: 20 }), /accurate=false .*不能设置 crf/);
  assert.match(one({ startTime: 0, preset: 'warp' }), /preset 只能是/);
  assert.deepEqual(paramErrors(trim, { startTime: '1:30', endTime: '1:31.5' }), []);
  assert.deepEqual(paramErrors(trim, { startTime: '0', endTime: '2', duration: '0' }), []);
});
