import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMergeArgs,
  buildNormalizeArgs,
  concatListContent,
  findIncompatibilities,
  pickNormalizeTarget,
  segmentAt,
} from '../../src/services/compose.service';
import type { MediaSummary } from '../../src/utils/media-probe';
import { composeSchema } from '../../src/schemas/compose.schema';
import { validate } from '../../src/middleware/validate';
import { isAllowedUpload } from '../../src/middleware/upload';

function media(overrides: Partial<MediaSummary> = {}): MediaSummary {
  return {
    duration: 8,
    video: {
      codec: 'h264',
      profile: 'High',
      width: 1280,
      height: 720,
      pixFmt: 'yuv420p',
      frameRate: '24/1',
      avgFrameRate: '24/1',
      duration: 7.958,
      rotation: 0,
      displayWidth: 1280,
      displayHeight: 720,
      sar: '1:1',
    },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, duration: 10 },
    ...overrides,
  };
}

test('findIncompatibilities：参数完全一致时可以流复制', () => {
  assert.deepEqual(findIncompatibilities([media(), media(), media()], true), []);
});

test('findIncompatibilities：分辨率不同要统一转码', () => {
  const small = media({ video: { ...media().video!, width: 640, height: 360 } });
  const reasons = findIncompatibilities([media(), small], true);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /第 2 个视频画面参数/);
});

test('findIncompatibilities：保留原声时缺音轨要统一转码，消除原声时不用', () => {
  const silent = media({ audio: undefined });
  assert.match(findIncompatibilities([media(), silent], true)[0], /无音轨/);
  assert.deepEqual(findIncompatibilities([media(), silent], false), []);
});

test('findIncompatibilities：MP4 装不下的编码即使参数一致也要转码', () => {
  const vp8 = media({ video: { ...media().video!, codec: 'vp8' } });
  assert.match(findIncompatibilities([vp8, vp8], true)[0], /vp8 不能直接放进 MP4/);
  const vorbis = media({ audio: { ...media().audio!, codec: 'vorbis' } });
  assert.match(findIncompatibilities([vorbis, vorbis], true)[0], /vorbis 不能直接放进 MP4/);
  // 消除原声时音轨不进输出，不用管音频编码
  assert.deepEqual(findIncompatibilities([vorbis, vorbis], false), []);
  const vp9 = media({ video: { ...media().video!, codec: 'vp9' } });
  assert.deepEqual(findIncompatibilities([vp9, vp9], true), []);
});

test('findIncompatibilities / pickNormalizeTarget：非方形像素（SAR）', () => {
  const anamorphic = media({ video: { ...media().video!, width: 960, sar: '4:3' } });
  // 尺寸编码都一样，只有 SAR 不同：流复制后第 2 段会按第 1 段的比例显示而变形
  assert.match(findIncompatibilities([media(), anamorphic], true)[0], /SAR 4:3/);
  // 画布按显示形状：960 存储像素 × 4/3 = 1280
  assert.deepEqual(
    { ...pickNormalizeTarget([anamorphic]), fps: undefined, sampleRate: undefined },
    { width: 1280, height: 720, fps: undefined, sampleRate: undefined },
  );
});

test('pickNormalizeTarget：奇数宽高取偶数，异常帧率回退到平均帧率', () => {
  const odd = media({
    video: {
      ...media().video!,
      width: 1279,
      height: 719,
      frameRate: '90000/1',
      avgFrameRate: '25/1',
    },
  });
  assert.deepEqual(pickNormalizeTarget([odd]), {
    width: 1280,
    height: 720,
    fps: '25/1',
    sampleRate: 48000,
  });
});

/** 手机竖拍：存储 1280x720，播放时转 90 度显示成 720x1280 */
function rotated(rotation = 90): MediaSummary {
  const swap = rotation % 180 !== 0;
  return media({
    video: {
      ...media().video!,
      rotation,
      displayWidth: swap ? 720 : 1280,
      displayHeight: swap ? 1280 : 720,
      sar: '1:1',
    },
  });
}

test('findIncompatibilities：显示方向不同时不能流复制', () => {
  // 编码参数一模一样，但流复制只会保留第 1 个文件的旋转信息，另一段会横着播
  const reasons = findIncompatibilities([rotated(), media()], true);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /第 2 个视频画面参数 .* 与第 1 个 .*旋转 90° 不同/);
  assert.equal(findIncompatibilities([media(), rotated(270)], true).length, 1);
  assert.equal(findIncompatibilities([media(), rotated(180)], true).length, 1);
  // 旋转角度一致时流复制能保留正确的方向
  assert.deepEqual(findIncompatibilities([rotated(), rotated()], true), []);
});

test('pickNormalizeTarget：第 1 个视频带旋转时按转正后的宽高', () => {
  assert.deepEqual(pickNormalizeTarget([rotated(), media()]), {
    width: 720,
    height: 1280,
    fps: '24/1',
    sampleRate: 48000,
  });
  const upsideDown = pickNormalizeTarget([rotated(180)]);
  assert.deepEqual([upsideDown.width, upsideDown.height], [1280, 720]);
});

test('pickNormalizeTarget：第 1 个片段没有音轨时用后面片段的采样率', () => {
  const target = pickNormalizeTarget([
    media({ audio: undefined }),
    media({ audio: { codec: 'aac', sampleRate: 44100, channels: 2, duration: 10 } }),
  ]);
  assert.equal(target.sampleRate, 44100);
});

test('buildNormalizeArgs：无音轨片段补静音并截到画面长度', () => {
  const args = buildNormalizeArgs(
    'in.mp4',
    media({ audio: undefined }),
    pickNormalizeTarget([media()]),
    true,
    'out.mp4',
  );
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'));
  assert.ok(args.includes('1:a:0'));
  // 按画面流时长截断，而不是 -shortest（会让音轨多出约 0.5 秒）
  assert.equal(args[args.indexOf('-t') + 1], '7.958');
  assert.ok(!args.includes('-shortest'));
});

test('buildNormalizeArgs：画面时长未知时退回 -shortest', () => {
  const unknown = media({ video: { ...media().video!, duration: 0 } });
  const args = buildNormalizeArgs('in.mp4', unknown, pickNormalizeTarget([media()]), true, 'o.mp4');
  assert.ok(args.includes('-shortest'));
  assert.ok(!args.includes('-t'));
});

test('buildNormalizeArgs：消除原声时输出不带音轨', () => {
  const args = buildNormalizeArgs(
    'in.mp4',
    media(),
    pickNormalizeTarget([media()]),
    false,
    'out.mp4',
  );
  assert.ok(args.includes('-an'));
  assert.ok(!args.includes('-c:a'));
});

test('buildMergeArgs：只用音乐时补静音，避免音乐短于视频时截断视频', () => {
  const args = buildMergeArgs({
    concatFile: 'list.txt',
    musicFile: 'bgm.wav',
    musicVolume: 0.8,
    muteOriginalAudio: true,
    videosHaveAudio: true,
    output: 'out.mp4',
  });
  assert.ok(args.includes('[1:a]volume=0.8,apad[outa]'));
  assert.ok(args.includes('-shortest'));
});

test('buildMergeArgs：混音关闭 normalize，原声保持原音量', () => {
  const args = buildMergeArgs({
    concatFile: 'list.txt',
    musicFile: 'bgm.wav',
    musicVolume: 0.5,
    muteOriginalAudio: false,
    videosHaveAudio: true,
    output: 'out.mp4',
  });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /normalize=0/);
  assert.match(filter, /\[1:a\]volume=0\.5\[bgm\]/);
  assert.match(filter, /alimiter/);
});

test('buildMergeArgs：视频都没有音轨时即使保留原声也只用音乐', () => {
  const args = buildMergeArgs({
    concatFile: 'list.txt',
    musicFile: 'bgm.wav',
    musicVolume: 1,
    muteOriginalAudio: false,
    videosHaveAudio: false,
    output: 'out.mp4',
  });
  assert.ok(args.includes('[1:a]volume=1,apad[outa]'));
});

test('buildMergeArgs：无音乐时按是否消除原声决定流复制还是去掉音轨', () => {
  const base = { concatFile: 'l.txt', musicVolume: 1, videosHaveAudio: true, output: 'o.mp4' };
  const mute = buildMergeArgs({ ...base, muteOriginalAudio: true });
  const keep = buildMergeArgs({ ...base, muteOriginalAudio: false });
  assert.ok(mute.includes('-an'));
  assert.deepEqual(keep.slice(6, 8), ['-c', 'copy']);
  assert.ok(keep.includes('+faststart') && mute.includes('+faststart'));
});

test('concatListContent：路径里的单引号被正确转义', () => {
  const content = concatListContent(["/tmp/it's.mp4"]);
  assert.equal(content, "ffconcat version 1.0\nfile '/tmp/it'\\''s.mp4'\n");
});

test('segmentAt：按真实片段时长推算当前片段', () => {
  assert.equal(segmentAt(0, [3, 5, 2]), 1);
  assert.equal(segmentAt(3.1, [3, 5, 2]), 2);
  assert.equal(segmentAt(9.5, [3, 5, 2]), 3);
  assert.equal(segmentAt(99, [3, 5, 2]), 3);
});

test('composeSchema：字符串形式的数字和布尔值会被转换', () => {
  const parsed = composeSchema.parse({
    videos: 'https://cdn.example.com/a.mp4',
    music: '',
    musicVolume: '0.8',
    muteOriginalAudio: 'true',
  });
  assert.deepEqual(parsed, {
    videos: ['https://cdn.example.com/a.mp4'],
    music: undefined,
    musicVolume: 0.8,
    muteOriginalAudio: true,
  });
});

test('composeSchema：拒绝非 http(s) 链接和越界音量', () => {
  const fileUrl = composeSchema.safeParse({ videos: ['file:///etc/passwd'] });
  assert.equal(fileUrl.success, false);
  assert.match(fileUrl.error!.issues[0].message, /http 或 https/);

  const loud = composeSchema.safeParse({ videos: ['https://a.com/v.mp4'], musicVolume: 'abc' });
  assert.equal(loud.success, false);
  assert.match(loud.error!.issues[0].message, /musicVolume/);
});

test('composeSchema：缺少 videos 与类型错误给出不同的中文提示', () => {
  const missing = composeSchema.safeParse({});
  assert.equal(missing.error!.issues[0].message, '请提供 videos 视频 URL 列表');
  const wrongType = composeSchema.safeParse({ videos: 42 });
  assert.equal(wrongType.error!.issues[0].message, 'videos 必须是视频 URL 数组');
});

test('validate：大量不合格元素时只返回前 10 条错误', () => {
  const sent: { status?: number; body?: { error: string } } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: { error: string }) {
      sent.body = body;
      return this;
    },
  };
  const req = { body: { videos: Array.from({ length: 30 }, () => 'not-a-url') } };
  let calledNext = false;
  validate(composeSchema)(req as never, res as never, () => {
    calledNext = true;
  });
  assert.equal(calledNext, false);
  assert.equal(sent.status, 400);
  assert.equal(sent.body!.error.split(', ').length, 10);
  assert.match(sent.body!.error, /另有 \d+ 条错误未列出$/);
});

test('validate：Express 5 没有请求体时仍返回字段级提示', () => {
  const sent: { body?: { error: string } } = {};
  const res = {
    status() {
      return this;
    },
    json(body: { error: string }) {
      sent.body = body;
      return this;
    },
  };
  validate(composeSchema)({ body: undefined } as never, res as never, () => {});
  assert.equal(sent.body!.error, '请提供 videos 视频 URL 列表');
});

test('isAllowedUpload：octet-stream 按扩展名放行，非媒体文件拒绝', () => {
  assert.equal(isAllowedUpload('application/octet-stream', 'clip.MP4'), true);
  assert.equal(isAllowedUpload('video/mp4', 'blob'), true);
  assert.equal(isAllowedUpload('application/octet-stream', 'notes.txt'), false);
  assert.equal(isAllowedUpload('text/plain', 'clip'), false);
});
