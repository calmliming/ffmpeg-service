import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transcode } from '../../../../src/operations/basic/transcode';
import { parseBitrate } from '../../../../src/operations/basic/encode';
import {
  AUDIO_CONTAINERS,
  CONTAINERS,
  VIDEO_CONTAINERS,
  videoVariant,
} from '../../../../src/operations/basic/formats';
import { parseResolution } from '../../../../src/operations/basic/resolution';
import { ffmpegSkip, generate, makeAudio, makeTempDir, makeVideo } from '../../../helpers/media';
import { createTestContext, paramErrors, runOperation } from '../../../helpers/op-context';
import { assertInside, assertNear, expectRunError, extOf, facts } from './helpers';

let dir = '';
let video = '';
let silent = '';
let wav = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-basic-transcode-');
  video = makeVideo(dir, 'in.mp4');
  silent = makeVideo(dir, 'silent.mp4', { audio: false });
  wav = makeAudio(dir, 'tone.wav');
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('transcode: 默认输出 mp4（h264 + aac），保持尺寸和时长', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(transcode, { file: [video] });
  try {
    const [out] = result.files;
    assertInside(ctx.outputRoot, out);
    assert.equal(extOf(out), 'mp4');
    const f = await facts(out);
    assert.match(f.formatName, /mp4/);
    assert.equal(f.video?.codec, 'h264');
    assert.equal(f.video?.width, 320);
    assert.equal(f.video?.height, 240);
    assert.equal(f.audio?.codec, 'aac');
    assertNear(f.duration, 2, 0.15);
    assert.equal(ctx.progressCalls.at(-1)?.fraction, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('transcode: 每种格式的默认编码都能实际输出', { skip: ffmpegSkip }, async () => {
  const short = makeVideo(dir, 'short.mp4', { size: '160x120', duration: 1 });
  const formats = [...VIDEO_CONTAINERS, ...AUDIO_CONTAINERS];
  for (const format of formats) {
    // 输入有画面：ogg 按 ogv 输出（theora + vorbis），其余按各自的默认编码
    const spec = CONTAINERS[videoVariant(format)];
    const { result, ctx } = await runOperation(transcode, { file: [short] }, { format });
    try {
      const [out] = result.files;
      assert.equal(extOf(out), format);
      const f = await facts(out);
      assert.equal(f.video?.codec, spec.defaultVideo, `${format} 视频编码`);
      assert.equal(f.audio?.codec, spec.defaultAudio, `${format} 音频编码`);
      assertNear(f.duration, 1, 0.2, `${format} 时长`);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('transcode: webm + 按宽度等比缩放 + crf', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    transcode,
    { file: [video] },
    { format: 'webm', resolution: '160x?', crf: '40', preset: 'ultrafast' },
  );
  try {
    const [out] = result.files;
    assert.equal(extOf(out), 'webm');
    const f = await facts(out);
    assert.equal(f.video?.codec, 'vp9');
    assert.equal(f.video?.width, 160);
    assert.equal(f.video?.height, 120);
    assert.equal(f.audio?.codec, 'opus');
  } finally {
    await ctx.cleanup();
  }
});

test(
  'transcode: 兼容旧版写法（编码器名、大写格式、裸数字码率、?x高）',
  { skip: ffmpegSkip },
  async () => {
    const { result, ctx } = await runOperation(
      transcode,
      { file: [video] },
      {
        format: '.MKV',
        videoCodec: 'libx264',
        audioCodec: 'libmp3lame',
        videoBitrate: '300',
        audioBitrate: 96,
        resolution: '?x120',
        fps: '15',
      },
    );
    try {
      const [out] = result.files;
      assert.equal(extOf(out), 'mkv');
      const f = await facts(out);
      assert.match(f.formatName, /matroska/);
      assert.equal(f.video?.codec, 'h264');
      assert.equal(f.video?.width, 160);
      assert.equal(f.video?.height, 120);
      assert.equal(f.video?.rate, '15/1');
      assert.equal(f.audio?.codec, 'mp3');
    } finally {
      await ctx.cleanup();
    }
  },
);

test('transcode: 宽x高 默认 contain 补边，cover 裁切', { skip: ffmpegSkip }, async () => {
  for (const fit of ['contain', 'cover', 'stretch']) {
    const { result, ctx } = await runOperation(
      transcode,
      { file: [video] },
      { resolution: '320x180', fit, preset: 'ultrafast' },
    );
    try {
      const f = await facts(result.files[0]);
      assert.equal(f.video?.width, 320, fit);
      assert.equal(f.video?.height, 180, fit);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('transcode: 转成纯音频格式时丢弃画面', { skip: ffmpegSkip }, async () => {
  for (const [format, codec] of [
    ['mp3', 'mp3'],
    ['flac', 'flac'],
    ['opus', 'opus'],
  ] as const) {
    const { result, ctx } = await runOperation(transcode, { file: [video] }, { format });
    try {
      const [out] = result.files;
      assert.equal(extOf(out), format);
      const f = await facts(out);
      assert.equal(f.video, undefined, `${format} 不应有画面`);
      assert.equal(f.audio?.codec, codec);
      assertNear(f.duration, 2, 0.15);
    } finally {
      await ctx.cleanup();
    }
  }
});

test(
  'transcode: format=ogg 与旧版一致，视频输入输出 theora + vorbis，不丢画面',
  { skip: ffmpegSkip },
  async () => {
    // 旧版直接 ffmpeg -i in out.ogg，得到 Ogg 视频；新版曾经悄悄只输出音频、任务照样 completed
    const withVideo = await runOperation(transcode, { file: [video] }, { format: 'ogg' });
    const audioOnly = await runOperation(transcode, { file: [wav] }, { format: 'oga' });
    const scaled = await runOperation(
      transcode,
      { file: [video] },
      { format: 'ogg', videoCodec: 'vp8', resolution: '160x?', noAudio: true },
    );
    try {
      assert.equal(extOf(withVideo.result.files[0]), 'ogg');
      const v = await facts(withVideo.result.files[0]);
      assert.equal(v.formatName, 'ogg');
      assert.equal(v.video?.codec, 'theora');
      assert.equal(v.video?.width, 320);
      assert.equal(v.audio?.codec, 'vorbis');
      assertNear(v.duration, 2, 0.15);

      assert.equal(extOf(audioOnly.result.files[0]), 'ogg');
      const a = await facts(audioOnly.result.files[0]);
      assert.equal(a.video, undefined);
      assert.equal(a.audio?.codec, 'vorbis');

      const s = await facts(scaled.result.files[0]);
      assert.equal(s.video?.codec, 'vp8');
      assert.equal(s.video?.width, 160);
      assert.equal(s.audio, undefined);
    } finally {
      await withVideo.ctx.cleanup();
      await audioOnly.ctx.cleanup();
      await scaled.ctx.cleanup();
    }
  },
);

test('transcode: format=wmv（旧版支持）输出 ASF，wmv2 + wmav2', { skip: ffmpegSkip }, async () => {
  // 96 kHz 5.1 的音源：wmav2 最高 48 kHz、2 声道，不自动降下来的话编码器直接打不开
  const hiRes = makeAudio(dir, 'hires.wav', { sampleRate: 96000, channels: 6, duration: 1 });
  const wmv = await runOperation(transcode, { file: [video] }, { format: 'WMV' });
  const asf = await runOperation(
    transcode,
    { file: [video] },
    { format: 'asf', videoCodec: 'wmv8', videoBitrate: '500k', audioBitrate: '96k' },
  );
  const audio = await runOperation(transcode, { file: [hiRes] }, { format: 'wmv' });
  try {
    for (const out of [wmv.result.files[0], asf.result.files[0]]) {
      assert.equal(extOf(out), 'wmv');
      const f = await facts(out);
      assert.equal(f.formatName, 'asf');
      assert.equal(f.video?.codec, 'wmv2');
      assert.equal(f.video?.width, 320);
      assert.equal(f.audio?.codec, 'wmav2');
      assertNear(f.duration, 2, 0.2);
    }
    const a = await facts(audio.result.files[0]);
    assert.equal(a.audio?.codec, 'wmav2');
    assert.equal(a.audio?.sampleRate, 48000);
    assert.equal(a.audio?.channels, 2);
  } finally {
    await wmv.ctx.cleanup();
    await asf.ctx.cleanup();
    await audio.ctx.cleanup();
  }
});

test('transcode: noAudio、采样率和声道', { skip: ffmpegSkip }, async () => {
  const muted = await runOperation(transcode, { file: [video] }, { noAudio: 'true' });
  try {
    const f = await facts(muted.result.files[0]);
    assert.ok(f.video);
    assert.equal(f.audio, undefined);
  } finally {
    await muted.ctx.cleanup();
  }

  const mono = await runOperation(
    transcode,
    { file: [video] },
    { format: 'm4a', sampleRate: '22050', channels: '1', audioBitrate: '64k' },
  );
  try {
    const f = await facts(mono.result.files[0]);
    assert.equal(f.video, undefined);
    assert.equal(f.audio?.sampleRate, 22050);
    assert.equal(f.audio?.channels, 1);
  } finally {
    await mono.ctx.cleanup();
  }
});

test('transcode: videoCodec=copy 直接复制画面', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    transcode,
    { file: [video] },
    { format: 'mov', videoCodec: 'copy', audioCodec: 'copy' },
  );
  try {
    const f = await facts(result.files[0]);
    assert.equal(extOf(result.files[0]), 'mov');
    assert.equal(f.video?.codec, 'h264');
    assert.equal(f.audio?.codec, 'aac');
    assertNear(f.duration, 2, 0.15);
  } finally {
    await ctx.cleanup();
  }
});

test('transcode: h265 输出到 mp4 带 hvc1 标签', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    transcode,
    { file: [silent] },
    { videoCodec: 'h265', preset: 'ultrafast' },
  );
  try {
    const f = await facts(result.files[0]);
    assert.equal(f.video?.codec, 'hevc');
    assert.equal(f.video?.tag, 'hvc1');
    assert.equal(f.audio, undefined, '没有音轨的输入不应生成音轨');
  } finally {
    await ctx.cleanup();
  }
});

test('transcode: mpg 自动换成 MPEG 标准帧率，奇数尺寸取偶数', { skip: ffmpegSkip }, async () => {
  const odd = makeVideo(dir, 'odd.mp4', { size: '321x241', rate: 15, duration: 1 });
  const { result, ctx } = await runOperation(transcode, { file: [odd] }, { format: 'mpeg' });
  try {
    assert.equal(extOf(result.files[0]), 'mpg');
    const f = await facts(result.files[0]);
    assert.equal(f.video?.codec, 'mpeg2video');
    assert.equal(f.video?.rate, '24000/1001');
    assert.equal(f.video?.width, 320);
    assert.equal(f.video?.height, 240);
    assert.equal(f.audio?.codec, 'mp2');
  } finally {
    await ctx.cleanup();
  }
});

test('transcode: stripMetadata 去掉标题等元数据', { skip: ffmpegSkip }, async () => {
  const tagged = path.join(dir, 'tagged.mp4');
  generate([
    '-i',
    video,
    '-c',
    'copy',
    '-metadata',
    'title=Secret',
    '-metadata',
    'location=+1+2/',
    tagged,
  ]);
  const kept = await runOperation(transcode, { file: [tagged] }, { videoCodec: 'copy' });
  const stripped = await runOperation(
    transcode,
    { file: [tagged] },
    { videoCodec: 'copy', stripMetadata: true },
  );
  try {
    assert.equal((await facts(kept.result.files[0])).tags.title, 'Secret');
    const f = await facts(stripped.result.files[0]);
    assert.equal(f.tags.title, undefined);
    assert.equal(f.tags.location, undefined);
    assert.equal(f.tags.encoder, undefined);
  } finally {
    await kept.ctx.cleanup();
    await stripped.ctx.cleanup();
  }
});

test('transcode: 纯音频输入转视频容器只输出音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(transcode, { file: [wav] }, { format: 'mp4' });
  try {
    const f = await facts(result.files[0]);
    assert.equal(f.video, undefined);
    assert.equal(f.audio?.codec, 'aac');
  } finally {
    await ctx.cleanup();
  }
});

test('transcode: 执行阶段才能发现的问题给出中文错误', { skip: ffmpegSkip }, async () => {
  await expectRunError(
    transcode,
    { file: [silent] },
    { format: 'mp3' },
    /输入文件没有音轨，不能转成纯音频格式 mp3/,
  );
  await expectRunError(
    transcode,
    { file: [video] },
    { format: 'webm', videoCodec: 'copy' },
    /源视频编码 h264 不能直接复制到 webm/,
  );
  await expectRunError(
    transcode,
    { file: [wav] },
    { noAudio: true },
    /输入文件没有视频画面，设置 noAudio 后没有可输出的内容/,
  );
  // 按比例缩放的输出尺寸要探测后才知道：2000x1200 的 400% 是 8000x4800，超过 8K
  const large = makeVideo(dir, 'large.mp4', { size: '2000x1200', duration: 0.2, audio: false });
  await expectRunError(
    transcode,
    { file: [large] },
    { resolution: '400%' },
    /输出分辨率 8000x4800 超出上限/,
  );
});

test('transcode: 取消时立即结束 ffmpeg 并以取消原因拒绝', { skip: ffmpegSkip }, async () => {
  const big = makeVideo(dir, 'big.mp4', { size: '640x480', duration: 3 });
  const controller = new AbortController();
  const ctx = createTestContext({ file: [big] }, { signal: controller.signal });
  try {
    const params = transcode.params.parse({ videoCodec: 'h265', preset: 'veryslow' });
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('任务已取消')), 300);
    await assert.rejects(transcode.run(ctx, params), /任务已取消/);
    assert.ok(Date.now() - started < 5000, '取消后应尽快返回');
  } finally {
    await ctx.cleanup();
  }
});

test('transcode: 参数校验', () => {
  const one = (raw: Record<string, unknown>) => paramErrors(transcode, raw).join(' | ');
  assert.match(one({ format: '../../etc/passwd' }), /format 只能是 mp4/);
  assert.match(one({ format: 'mp4/../../x' }), /format 只能是/);
  assert.match(one({ format: 'gif' }), /请用 \/api\/process\/gif/);
  assert.match(one({ videoCodec: 'vp8' }), /mp4 不支持 vp8 视频编码/);
  assert.match(one({ format: 'webm', audioCodec: 'aac' }), /webm 不支持 aac 音频编码/);
  assert.match(one({ format: 'webm', videoCodec: 'libx264' }), /webm 不支持 h264 视频编码/);
  assert.match(one({ videoCodec: 'prores' }), /videoCodec 只能是/);
  assert.match(one({ audioCodec: 'dts' }), /audioCodec 只能是/);
  assert.match(one({ crf: '60' }), /h264 编码的 crf 范围是 0-51/);
  assert.match(one({ crf: '70' }), /crf 必须是 0 到 63 之间的整数/);
  assert.match(one({ format: 'avi', videoCodec: 'mpeg4', crf: 20 }), /mpeg4 编码不支持 crf/);
  assert.match(one({ preset: 'turbo' }), /preset 只能是 ultrafast/);
  assert.match(
    one({ format: 'mp3', resolution: '640x480' }),
    /mp3 是纯音频格式，不能设置 resolution/,
  );
  assert.match(one({ videoCodec: 'copy', fps: 30 }), /videoCodec=copy .*不能同时设置 fps/);
  assert.match(one({ audioCodec: 'copy', sampleRate: 44100 }), /audioCodec=copy .*sampleRate/);
  assert.match(
    one({ noAudio: 'yes', audioBitrate: '128k' }),
    /noAudio=true 时不能再设置 audioBitrate/,
  );
  assert.match(one({ noAudio: 'maybe' }), /noAudio 必须是布尔值/);
  assert.match(one({ channels: '6' }), /channels 必须是 1 到 2 之间的整数/);
  assert.match(one({ format: 'webm', sampleRate: 44100 }), /opus 编码只支持采样率/);
  assert.match(
    one({ format: 'flv', audioCodec: 'mp3', sampleRate: 48000 }),
    /flv 里的 mp3 只支持采样率/,
  );
  assert.match(one({ resolution: '99999x1' }), /resolution 必须是 宽x高/);
  assert.match(one({ resolution: '7680x7680' }), /总像素不超过 7680x4320/);
  assert.match(one({ resolution: 'big' }), /resolution 必须是/);
  assert.match(one({ fit: 'cover' }), /fit 和 padColor 只在 resolution 为 宽x高/);
  assert.match(one({ resolution: '640x?', padColor: 'red' }), /fit 和 padColor/);
  assert.match(
    one({ resolution: '640x480', fit: 'cover', padColor: 'red' }),
    /padColor 只在 fit=contain/,
  );
  assert.match(one({ padColor: 'red;rm' }), /padColor 必须是颜色名/);
  assert.match(one({ videoBitrate: '5' }), /videoBitrate 必须在 10k 到 200M 之间/);
  assert.match(one({ videoBitrate: '1;2' }), /videoBitrate 必须是码率/);
  assert.match(one({ audioBitrate: '900k' }), /aac 编码的 audioBitrate 必须在 8k 到 640k 之间/);
  assert.match(one({ fps: '200' }), /fps 必须是 1 到 120 之间的数字/);
  assert.match(one({ format: 'mpg', fps: 15 }), /mpeg2video 只支持帧率/);
  assert.match(
    one({ format: 'ogg', videoCodec: 'vp9' }),
    /ogg 不支持 vp9 视频编码，可选 theora \/ vp8/,
  );
  assert.match(one({ format: 'wmv', videoCodec: 'h264' }), /wmv 不支持 h264 视频编码，可选 wmv2/);
  assert.match(one({ format: 'wmv', audioCodec: 'aac' }), /wmv 不支持 aac 音频编码/);
  assert.match(one({ format: 'wmv', crf: 20 }), /wmv2 编码不支持 crf/);
  assert.match(one({ format: 'wmv', audioBitrate: '16k' }), /wmav2 编码的 audioBitrate 必须在 32k/);
  assert.match(one({ format: 'wmv', sampleRate: 96000 }), /wmav2 编码只支持采样率/);
  assert.deepEqual(paramErrors(transcode, { format: 'wmv' }), []);
  assert.deepEqual(paramErrors(transcode, { format: '.asf', videoBitrate: '800k' }), []);
  assert.deepEqual(paramErrors(transcode, { format: 'ogg', resolution: '640x?', crf: 10 }), [
    'theora 编码不支持 crf，请改用 videoBitrate 控制质量',
  ]);
  assert.deepEqual(paramErrors(transcode, { format: 'ogg', fps: 15, noAudio: true }), []);
  assert.deepEqual(paramErrors(transcode, { format: 'MPEG', fps: '29.97' }), []);
  assert.deepEqual(paramErrors(transcode, { videoCodec: 'hevc', crf: 30, videoBitrate: '2M' }), []);
  assert.deepEqual(paramErrors(transcode, { format: '', resolution: '' }), [], '空串视为没传');
});

test('transcode: 码率和分辨率解析', () => {
  assert.equal(parseBitrate('128k'), 128000);
  assert.equal(parseBitrate('2.5M'), 2500000);
  assert.equal(parseBitrate('1000'), 1000000, '旧版裸数字按 kbps');
  assert.equal(parseBitrate('800000'), 800000);
  assert.deepEqual(parseResolution('1281x721'), { kind: 'fixed', width: 1280, height: 720 });
  assert.deepEqual(parseResolution('640x?'), { kind: 'width', width: 640 });
  assert.deepEqual(parseResolution('-1:480'), { kind: 'height', height: 480 });
  assert.deepEqual(parseResolution('50%'), { kind: 'percent', percent: 50 });
  assert.equal(parseResolution('?x?'), undefined);
  assert.equal(parseResolution('0x100'), undefined);
});
