import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compose } from '../../../../src/operations/visual/compose';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';

let dir = '';
let a = '';
let b = '';
let small = '';
let silent = '';
let music = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-compose-op-');
  a = makeVideo(dir, 'a.mp4', { freq: 440 });
  b = makeVideo(dir, 'b.mp4', { freq: 660 });
  small = makeVideo(dir, 'small.mp4', { size: '160x120', rate: 30 });
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
  music = makeAudio(dir, 'bgm.mp3', { duration: 6 });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('compose：参数一致时直接拼接并混入背景音乐', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    compose,
    { videos: [a, b], music: [music] },
    { musicVolume: '0.5' },
  );
  try {
    assert.equal(result.files.length, 1);
    assert.match(result.files[0], /\.mp4$/);
    const info = await probeMedia(result.files[0]);
    assert.ok(Math.abs(info.duration - 4) < 0.3, `时长 ${info.duration}`);
    assert.equal(info.video?.width, 320);
    assert.equal(info.audio?.codec, 'aac');
    const data = result.data as { normalized: boolean; duration: number };
    assert.equal(data.normalized, false);

    // 第一次汇报只带 totalVideos，阶段等 composeFiles 判断完再报
    assert.equal(ctx.progressCalls[0].extra?.phase, undefined);
    const phases = new Set(ctx.progressCalls.slice(1).map((c) => c.extra?.phase));
    assert.deepEqual([...phases], ['merging']);
    assert.ok(ctx.progressCalls.every((c) => c.extra?.totalVideos === 2));
    const last = ctx.progressCalls.at(-1);
    assert.equal(last?.fraction, 1);
    assert.equal(last?.extra?.currentVideoIndex, 2);
    // 中间文件放在 workDir，结束后已清理
    assert.deepEqual(fs.readdirSync(ctx.workDir), []);
  } finally {
    await ctx.cleanup();
  }
});

test('compose：参数不一致时先统一转码，进度经过 normalizing', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(compose, { videos: [a, small, silent] }, {});
  try {
    const info = await probeMedia(result.files[0]);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.ok(info.audio, '缺音轨的片段补静音后整体仍有音轨');
    assert.ok(Math.abs(info.duration - 6) < 0.4, `时长 ${info.duration}`);
    const data = result.data as { normalized: boolean; reasons: string[] };
    assert.equal(data.normalized, true);
    assert.ok(data.reasons.length > 0);

    const phases = ctx.progressCalls.map((c) => c.extra?.phase);
    assert.ok(phases.includes('normalizing'));
    assert.equal(phases.at(-1), 'merging');
    const indexes = ctx.progressCalls
      .map((c) => c.extra?.currentVideoIndex)
      .filter((i): i is number => i !== undefined);
    assert.ok(indexes.includes(3));
    const fractions = ctx.progressCalls.map((c) => c.fraction);
    assert.deepEqual(
      fractions,
      [...fractions].sort((x, y) => x - y),
    );
  } finally {
    await ctx.cleanup();
  }
});

test('compose：消除原声且没有音乐时输出无声视频', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    compose,
    { videos: [a] },
    { muteOriginalAudio: 'true' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(info.video);
    assert.equal(info.audio, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('compose：片段是纯音频、背景音乐没有音轨时报错', { skip: ffmpegSkip }, async () => {
  const audioCtx = createTestContext({ videos: [a, music] });
  try {
    await assert.rejects(
      compose.run(audioCtx, compose.params.parse({})),
      /第 2 个文件不包含视频画面/,
    );
    assert.deepEqual(fs.readdirSync(audioCtx.outputRoot), []);
  } finally {
    await audioCtx.cleanup();
  }
  const musicCtx = createTestContext({ videos: [a], music: [silent] });
  try {
    await assert.rejects(compose.run(musicCtx, compose.params.parse({})), /背景音乐不包含音频/);
  } finally {
    await musicCtx.cleanup();
  }
});

test('compose：已取消的任务不再执行', { skip: ffmpegSkip }, async () => {
  const controller = new AbortController();
  controller.abort(new Error('任务已取消'));
  const ctx = createTestContext({ videos: [a] }, { signal: controller.signal });
  try {
    await assert.rejects(compose.run(ctx, compose.params.parse({})), /任务已取消/);
  } finally {
    await ctx.cleanup();
  }
});

test('compose：参数转换和校验与旧版一致', () => {
  const parsed = compose.params.parse({ musicVolume: '0.8', muteOriginalAudio: 'true' });
  assert.deepEqual(parsed, { musicVolume: 0.8, muteOriginalAudio: true });
  assert.deepEqual(compose.params.parse({}), { musicVolume: 1, muteOriginalAudio: false });
  const provided = { videos: 2 };
  assert.deepEqual(paramErrors(compose, { musicVolume: '2' }, provided), [
    'musicVolume 不能大于 1',
  ]);
  assert.deepEqual(paramErrors(compose, { musicVolume: '-1' }, provided), [
    'musicVolume 不能小于 0',
  ]);
  assert.deepEqual(paramErrors(compose, { musicVolume: 'abc' }, provided), [
    'musicVolume 必须是 0 到 1 之间的数字',
  ]);
  assert.deepEqual(paramErrors(compose, { muteOriginalAudio: 'maybe' }, provided), [
    'muteOriginalAudio 必须是布尔值',
  ]);
  // 表单把没填的字段发成空串时按默认值处理
  assert.deepEqual(paramErrors(compose, { musicVolume: '', muteOriginalAudio: '' }, provided), []);
});
