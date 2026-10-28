import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { mute } from '../../../../src/operations/effects/mute';
import { probeMedia } from '../../../../src/utils/media-probe';
import { streamInfo, videoPacketsHash } from './fixtures';

let dir = '';
let video = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-mute-');
  video = makeVideo(dir, 'in.mp4', { size: '320x240', duration: 2 });
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('mute：去掉音轨，画面逐字节流复制，mp4 保持 mp4', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(mute, { file: [video] });
  try {
    const out = result.files[0];
    assert.match(out, /\.mp4$/);
    const info = await probeMedia(out);
    assert.equal(info.audio, undefined);
    assert.equal(info.video?.codec, 'h264');
    assert.ok(Math.abs(info.duration - 2) < 0.15);
    assert.equal(videoPacketsHash(out), videoPacketsHash(video));
    assert.deepEqual(result.data, { container: 'mp4', removedAudioTracks: 1 });
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('mute：按探测到的容器输出 mkv / webm / mov，avi 转成 mp4', { skip: ffmpegSkip }, async () => {
  const mkv = path.join(dir, 'in.mkv');
  generate(['-i', video, '-c', 'copy', mkv]);
  const webm = path.join(dir, 'in.webm');
  generate([
    '-i',
    video,
    '-t',
    '1',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-b:v',
    '200k',
    '-c:a',
    'libopus',
    webm,
  ]);
  const mov = path.join(dir, 'in.mov');
  generate(['-i', video, '-c', 'copy', mov]);
  const avi = path.join(dir, 'in.avi');
  generate(['-i', video, '-t', '1', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', avi]);

  const cases: [string, string, string][] = [
    [mkv, 'mkv', 'matroska'],
    [webm, 'webm', 'webm'],
    [mov, 'mov', 'mov'],
    [avi, 'mp4', 'mp4'],
  ];
  for (const [file, ext, format] of cases) {
    const { result, ctx } = await runOperation(mute, { file: [file] });
    try {
      const out = result.files[0];
      assert.ok(out.endsWith(`.${ext}`), `${path.basename(file)} → ${out}`);
      const info = await streamInfo(out);
      assert.deepEqual(info.audioCodecs, [], file);
      assert.ok(info.format.includes(format), `${file}: ${info.format}`);
      assert.equal(videoPacketsHash(out), videoPacketsHash(file), file);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('mute：扩展名不可信时按内容判断；无音轨输入同样成功', { skip: ffmpegSkip }, async () => {
  // URL 下载的文件可能没有扩展名或扩展名是错的
  const disguised = path.join(dir, 'download.bin');
  fs.copyFileSync(video, disguised);
  const a = await runOperation(mute, { file: [disguised] });
  try {
    assert.match(a.result.files[0], /\.mp4$/);
  } finally {
    await a.ctx.cleanup();
  }

  const silent = makeVideo(dir, 'silent.mp4', { duration: 1, audio: false });
  const b = await runOperation(mute, { file: [silent] });
  try {
    assert.deepEqual(b.result.data, { container: 'mp4', removedAudioTracks: 0 });
  } finally {
    await b.ctx.cleanup();
  }
});

test('mute：纯音频输入返回明确错误', { skip: ffmpegSkip }, async () => {
  const audio = makeAudio(dir, 'a.wav', { duration: 1 });
  await assert.rejects(runOperation(mute, { file: [audio] }), /输入文件不包含视频画面/);
});

test('mute：没有参数，多余字段被忽略', () => {
  assert.deepEqual(paramErrors(mute, {}), []);
  assert.deepEqual(paramErrors(mute, { foo: 'bar' }), []);
});
