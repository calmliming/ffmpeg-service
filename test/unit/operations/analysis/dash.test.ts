import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../../src/config';
import { ffmpegSkip, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { dash } from '../../../../src/operations/analysis/dash';
import { probeMedia } from '../../../../src/utils/media-probe';
import { runExpectingError } from './helpers';

let dir = '';
let video = '';
let wide = '';
let audio = '';
let hfr = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-dash-');
  video = makeVideo(dir, 'video.mp4', { duration: 3 });
  wide = makeVideo(dir, 'wide.mp4', { size: '640x360', duration: 2, audio: false });
  audio = makeAudio(dir, 'tone.wav', { duration: 1 });
  // 240 fps 的慢动作素材
  hfr = makeVideo(dir, 'hfr.mp4', { size: '256x144', rate: 240, duration: 1.2, audio: false });
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface DashData {
  manifest: string;
  hlsMaster?: string;
  audio: boolean;
  fileCount: number;
  renditions: { name: string; representationId: string; width: number; height: number }[];
}

const read = (file: string) => fs.readFileSync(file, 'utf8');
const attr = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

test(
  'dash：两档画面 + 一路音频，manifest 用 SegmentList 逐个引用分片',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      dash,
      { file: [video] },
      { renditions: '240,144', segmentDuration: '2' },
    );
    try {
      const data = result.data as DashData;
      const outDir = path.dirname(result.primary!);
      assert.equal(path.basename(result.primary!), 'manifest.mpd');
      assert.equal(path.dirname(outDir), ctx.outputRoot);
      assert.ok(result.files.every((f) => path.dirname(f) === outDir));
      const names = result.files.map((f) => path.basename(f));
      // 2 档画面 + 1 路音频，各一个 init 和 2 个分片
      for (const id of [0, 1, 2]) {
        assert.ok(names.includes(`init-stream${id}.m4s`), String(names));
        assert.ok(names.includes(`chunk-stream${id}-00001.m4s`), String(names));
        assert.ok(names.includes(`chunk-stream${id}-00002.m4s`), String(names));
      }
      assert.equal(names.length, 10);
      assert.equal(data.fileCount, 10);
      assert.equal(data.audio, true);
      assert.equal(data.hlsMaster, undefined);
      assert.deepEqual(
        data.renditions.map((r) => [r.name, r.representationId, r.width, r.height]),
        [
          ['240p', '0', 320, 240],
          ['144p', '1', 192, 144],
        ],
      );

      const mpd = read(result.primary!);
      assert.match(mpd, /type="static"/);
      assert.deepEqual(attr(mpd, 'contentType'), ['video', 'audio']);
      // 不用 SegmentTemplate 模板：每个文件都写出完整的文件名，对象存储预签名模式才能把每个引用换成签名 URL
      assert.doesNotMatch(mpd, /SegmentTemplate|\$/);
      assert.deepEqual(attr(mpd, 'sourceURL'), [
        'init-stream0.m4s',
        'init-stream1.m4s',
        'init-stream2.m4s',
      ]);
      assert.deepEqual(
        attr(mpd, 'media'),
        [0, 1, 2].flatMap((id) => [`chunk-stream${id}-00001.m4s`, `chunk-stream${id}-00002.m4s`]),
      );
      // FFmpeg 的 DASH 解复用器把 SegmentList 的 startNumber 当成列表下标，写 1 会跳过第一个分片
      assert.deepEqual(attr(mpd, 'startNumber'), ['0', '0', '0']);
      // 不能出现本机路径（xsi:schemaLocation 里有 http://，只查分片引用和反斜杠）
      assert.ok(!mpd.includes('\\'));
      assert.ok(!mpd.includes(outDir.split(path.sep).join('/')));
      assert.ok([...attr(mpd, 'sourceURL'), ...attr(mpd, 'media')].every((u) => !/[:/]/.test(u)));
      assert.deepEqual(attr(mpd, 'width'), ['320', '192']);
      // 清单能被 FFmpeg 的 DASH 解复用器完整读出：3 秒 25 fps 共 75 帧。
      // 在输出目录里按文件名打开：DASH 解复用器拼不出带反斜杠的 Windows 路径下的相对分片地址
      const frames = execFileSync(
        config.ffprobePath,
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_frames',
          '-of',
          'csv=p=0',
          'manifest.mpd',
        ],
        { encoding: 'utf8', cwd: outDir },
      );
      // DASH 输入的流会在 program 和 stream 两节各打印一次，取第一行
      assert.equal(Number(frames.trim().split(/\r?\n/)[0].replace(/,$/, '')), 75);

      const init = await probeMedia(path.join(outDir, 'init-stream1.m4s'));
      assert.equal(init.video?.codec, 'h264');
      assert.equal(init.video?.width, 192);
      assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('dash：hlsPlaylist 同时生成引用同一批分片的 HLS 播放列表', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(dash, { file: [video] }, { hlsPlaylist: 'true' });
  try {
    const data = result.data as DashData;
    assert.equal(data.hlsMaster, 'master.m3u8');
    const outDir = path.dirname(result.primary!);
    const master = read(path.join(outDir, 'master.m3u8'));
    assert.match(master, /#EXT-X-STREAM-INF:.*RESOLUTION=320x240/);
    assert.match(master, /TYPE=AUDIO.*URI="media_1\.m3u8"/);
    const media = read(path.join(outDir, 'media_0.m3u8'));
    assert.match(media, /#EXT-X-MAP:URI="init-stream0\.m4s"/);
    assert.match(media, /^chunk-stream0-00001\.m4s$/m);
  } finally {
    await ctx.cleanup();
  }
});

test('dash：没有音轨、16:9 源，各档显示比例一致', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    dash,
    { file: [wide] },
    { renditions: '360,240', segmentDuration: 2 },
  );
  try {
    const data = result.data as DashData;
    assert.equal(data.audio, false);
    assert.deepEqual(
      data.renditions.map((r) => [r.width, r.height]),
      [
        [640, 360],
        [426, 240],
      ],
    );
    const mpd = read(result.primary!);
    assert.deepEqual(attr(mpd, 'contentType'), ['video']);
    // 426x240 不是严格的 16:9，用像素宽高比补齐，整个 AdaptationSet 的画面比例都是 16:9
    assert.match(mpd, /par="16:9"/);
    const sars = attr(mpd, 'sar').map((s) => s.split(':').map(Number));
    const widths = attr(mpd, 'width').map(Number);
    const heights = attr(mpd, 'height').map(Number);
    sars.forEach(([n, d], i) => {
      assert.ok(Math.abs((widths[i] * n) / d / heights[i] - 16 / 9) < 0.001);
    });
  } finally {
    await ctx.cleanup();
  }
});

test('dash：240 fps 的源降到 60 fps', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(dash, { file: [hfr] }, { segmentDuration: 2 });
  try {
    assert.deepEqual(attr(read(result.primary!), 'frameRate'), ['60/1']);
  } finally {
    await ctx.cleanup();
  }
});

test('dash：纯音频文件直接失败', { skip: ffmpegSkip }, async () => {
  const { error, outputs } = await runExpectingError(dash, { file: [audio] });
  assert.match(error.message, /没有视频画面/);
  assert.deepEqual(outputs, []);
});

test('dash：参数校验', () => {
  assert.deepEqual(paramErrors(dash, { segmentDuration: '12' }), [
    'segmentDuration 必须是 2 到 10 之间的整数',
  ]);
  assert.deepEqual(paramErrors(dash, { hlsPlaylist: 'sometimes' }), [
    'hlsPlaylist 必须是布尔值（true / false）',
  ]);
  assert.equal(paramErrors(dash, { renditions: '5000' }).length, 1);
  const parsed = dash.params.parse({});
  assert.equal(parsed.segmentDuration, 4);
  assert.equal(parsed.audioBitrate, 128);
  assert.equal(parsed.hlsPlaylist, false);
});
