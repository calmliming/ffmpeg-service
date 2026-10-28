import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ffmpegSkip, generate, makeTempDir, makeVideo } from '../../../helpers/media';
import { createTestContext } from '../../../helpers/op-context';
import {
  enableExpr,
  inspectVideo,
  keepAudioArgs,
  num,
  parseRegions,
  toPixels,
  withEnable,
  type VideoInput,
} from '../../../../src/operations/effects/shared';
import { muteContainer } from '../../../../src/operations/effects/mute';
import { fitSize, parseBitrate, videoCodecArgs } from '../../../../src/operations/effects/compress';
import fs from 'node:fs';
import path from 'node:path';

let dir = '';
before(() => {
  dir = makeTempDir('ffsvc-effects-shared-');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('parseRegions 接受对象数组、二维数组、扁平数组、单个对象和 x,y,w,h 字符串', () => {
  const expected = [{ x: 10, y: 20, width: 100, height: 50 }];
  assert.deepEqual(parseRegions([{ x: 10, y: 20, width: 100, height: 50 }], 'regions'), expected);
  assert.deepEqual(parseRegions('[{"x":10,"y":20,"w":100,"h":50}]', 'regions'), expected);
  assert.deepEqual(parseRegions([[10, 20, 100, 50]], 'regions'), expected);
  assert.deepEqual(parseRegions('[10,20,100,50]', 'regions'), expected);
  assert.deepEqual(
    parseRegions({ x: '10', y: '20', width: '100', height: '50' }, 'regions'),
    expected,
  );
  assert.deepEqual(parseRegions('10,20,100,50; 1, 2, 3, 4', 'regions'), [
    ...expected,
    { x: 1, y: 2, width: 3, height: 4 },
  ]);
  assert.equal(parseRegions(undefined, 'regions'), undefined);
  assert.equal(parseRegions([], 'regions'), undefined);
});

test('parseRegions 解析每个区域自己的时间段', () => {
  const regions = parseRegions(
    [{ x: 0, y: 0, width: 10, height: 10, startTime: '00:00:01.5', end: 3 }],
    'regions',
  );
  assert.deepEqual(regions, [{ x: 0, y: 0, width: 10, height: 10, startTime: 1.5, endTime: 3 }]);
});

test('parseRegions 对非法输入给出具体的中文错误', () => {
  assert.equal(parseRegions('[{', 'regions'), 'regions 不是合法的 JSON');
  assert.match(String(parseRegions('1,2,3', 'regions')), /第 1 个区域格式不正确/);
  assert.match(String(parseRegions([[1, 2, 0, 4]], 'regions')), /第 1 个区域的宽和高必须大于 0/);
  assert.match(String(parseRegions([[1, 'a', 3, 4]], 'regions')), /坐标必须是数字/);
  assert.match(String(parseRegions(42, 'regions')), /格式不正确/);
  const many = Array.from({ length: 11 }, () => [0, 0, 10, 10]);
  assert.equal(parseRegions(many, 'regions'), 'regions 最多 10 个区域');
  assert.match(
    String(parseRegions([{ x: 0, y: 0, width: 5, height: 5, startTime: 3, endTime: 2 }], 'r')),
    /endTime 必须大于 startTime/,
  );
  assert.match(
    String(parseRegions([{ x: 0, y: 0, width: 5, height: 5, startTime: 'abc' }], 'r')),
    /startTime 必须是秒数或 HH:MM:SS/,
  );
});

test('toPixels 把百分比换算成像素', () => {
  const r = toPixels({ x: 10, y: 50, width: 50, height: 25 }, 'percent', 320, 240);
  assert.deepEqual(r, { x: 32, y: 120, width: 160, height: 60 });
});

test('enableExpr / withEnable / num 生成的表达式只含数字', () => {
  assert.equal(enableExpr(), undefined);
  assert.equal(enableExpr(0), undefined);
  assert.equal(enableExpr(1.5, 3), `'between(t,1.5,3)'`);
  assert.equal(enableExpr(2), `'gte(t,2)'`);
  assert.equal(enableExpr(undefined, 4), `'lte(t,4)'`);
  assert.equal(withEnable('negate', `'gte(t,1)'`), `negate=enable='gte(t,1)'`);
  assert.equal(withEnable('hue=s=0', `'gte(t,1)'`), `hue=s=0:enable='gte(t,1)'`);
  assert.equal(num(1e-7), '0');
  assert.equal(num(100), '100');
  assert.equal(num(0.1 + 0.2), '0.3');
  assert.equal(num(-0.0001), '0');
});

test('keepAudioArgs：兼容编码流复制，不兼容转 AAC，没有音轨不加参数', () => {
  const base = { audioCodecs: [] as string[] } as unknown as VideoInput;
  assert.deepEqual(keepAudioArgs(base), []);
  assert.deepEqual(keepAudioArgs({ ...base, audioCodecs: ['aac', 'opus'] }), [
    '-map',
    '0:a',
    '-c:a',
    'copy',
  ]);
  assert.deepEqual(keepAudioArgs({ ...base, audioCodecs: ['aac', 'pcm_s16le'] }), [
    '-map',
    '0:a',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
  ]);
});

test('muteContainer 按探测结果而不是扩展名选择容器', () => {
  const mp4 = { formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', videoCodec: 'h264' };
  assert.equal(muteContainer(mp4), 'mp4');
  assert.equal(muteContainer({ ...mp4, majorBrand: 'qt' }), 'mov');
  assert.equal(muteContainer({ ...mp4, videoCodec: 'prores' }), 'mov');
  const mkv = { formatName: 'matroska,webm', majorBrand: '', videoCodec: 'h264' };
  assert.equal(muteContainer(mkv), 'mkv');
  assert.equal(muteContainer({ ...mkv, videoCodec: 'vp9' }), 'webm');
  assert.equal(muteContainer({ formatName: 'avi', majorBrand: '', videoCodec: 'mpeg4' }), 'mp4');
  assert.equal(muteContainer({ formatName: 'asf', majorBrand: '', videoCodec: 'wmv2' }), 'mkv');
});

test('fitSize 只缩不放、保持比例、结果为偶数且不超过上限', () => {
  assert.deepEqual(fitSize(1920, 1080, 1280), { width: 1280, height: 720, scaled: true });
  assert.deepEqual(fitSize(1080, 1920, 1280, 1280), { width: 720, height: 1280, scaled: true });
  assert.deepEqual(fitSize(640, 360, 1280), { width: 640, height: 360, scaled: false });
  const odd = fitSize(1920, 1080, 101);
  assert.ok(odd.width <= 101 && odd.width % 2 === 0 && odd.height % 2 === 0);
});

test('parseBitrate 支持 k / M 后缀，小于 1000 的纯数字按 kbps', () => {
  assert.equal(parseBitrate('128k'), 128000);
  assert.equal(parseBitrate('1.5M'), 1500000);
  assert.equal(parseBitrate('96000'), 96000);
  assert.equal(parseBitrate('128'), 128000);
});

test('videoCodecArgs：两遍编码的统计文件只写文件名', () => {
  const x264 = videoCodecArgs('h264', 'medium', { bitrate: 500000, pass: 1 });
  assert.deepEqual(x264.slice(-4), ['-pass', '1', '-passlogfile', 'passlog']);
  const x265 = videoCodecArgs('h265', 'fast', { bitrate: 500000, pass: 2 });
  assert.ok(x265.includes('log-level=error:pass=2:stats=x265_stats.log'));
  const vp9 = videoCodecArgs('vp9', 'slow', { crf: 33 });
  assert.deepEqual(vp9.slice(-4), ['-crf', '33', '-b:v', '0']);
});

test('inspectVideo 识别旋转、封面以外的主画面和全部音轨', { skip: ffmpegSkip }, async () => {
  const src = makeVideo(dir, 'src.mp4', { size: '320x240', duration: 1 });
  const rotated = path.join(dir, 'rotated.mp4');
  generate(['-display_rotation', '90', '-i', src, '-c', 'copy', rotated]);
  const ctx = createTestContext({ file: [rotated] });
  try {
    const info = await inspectVideo(ctx, rotated);
    assert.equal(info.rotation, 90);
    assert.equal(info.width, 240);
    assert.equal(info.height, 320);
    assert.deepEqual(info.audioCodecs, ['aac']);
    assert.equal(info.videoIndex, 0);
    assert.ok(Math.abs(info.duration - 1) < 0.2);
    assert.equal(info.fps, 25);
  } finally {
    await ctx.cleanup();
  }
});

test('inspectVideo 对非媒体文件给出中文错误', { skip: ffmpegSkip }, async () => {
  const junk = path.join(dir, 'junk.mp4');
  fs.writeFileSync(junk, 'not a video at all');
  const ctx = createTestContext({ file: [junk] });
  try {
    await assert.rejects(inspectVideo(ctx, junk), /无法解析输入文件/);
  } finally {
    await ctx.cleanup();
  }
});
