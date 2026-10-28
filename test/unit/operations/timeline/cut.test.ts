import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cutOperation, parseRanges, planCut } from '../../../../src/operations/timeline/cut';
import { probeMedia } from '../../../../src/utils/media-probe';
import { ffmpegSkip, makeAudio, makeTempDir } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { frameLuma, makeRampVideo, meanVolumeDb, near, rampLuma } from './helpers';

let dir = '';
/** 8 秒，亮度每秒 +30，前 3 秒有声音 */
let ramp = '';
let silent = '';

before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-cut-');
  ramp = makeRampVideo(dir, 'ramp.mp4', { duration: 8, toneUntil: 3 });
  silent = makeRampVideo(dir, 'silent.mp4', { duration: 4 });
});

after(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

test('parseRanges 支持多种写法', () => {
  assert.deepEqual(parseRanges('10-20, 35.5-40'), [
    { start: 10, end: 20 },
    { start: 35.5, end: 40 },
  ]);
  assert.deepEqual(parseRanges('00:00:10-00:00:20,1:05-'), [{ start: 10, end: 20 }, { start: 65 }]);
  assert.deepEqual(parseRanges(['1-2', '3-4,5-6']), [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 5, end: 6 },
  ]);
  assert.deepEqual(parseRanges([[1, 2], { start: '00:00:03', end: 4 }, { start: 5 }]), [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 5 },
  ]);
  assert.deepEqual(parseRanges('[{"start":1,"end":2}]'), [{ start: 1, end: 2 }]);
});

test('parseRanges 的错误信息', () => {
  assert.match(String(parseRanges('abc')), /ranges 第 1 个区间 "abc" 格式不对/);
  assert.match(String(parseRanges('1-2,5-3')), /第 2 个区间的结束时间必须大于开始时间/);
  assert.match(String(parseRanges('1-2-3')), /第 1 个区间 "1-2-3" 格式不对/);
  assert.match(String(parseRanges('[1,')), /不是合法的 JSON 数组/);
  assert.match(String(parseRanges(42)), /请提供 ranges/);
  const many = Array.from({ length: 101 }, (_, i) => `${i}-${i + 0.5}`).join(',');
  assert.equal(parseRanges(many), 'ranges 最多 100 个区间，当前 101 个');
});

test('planCut 合并重叠区间并计算保留部分', () => {
  const ranges = [
    { start: 5, end: 7 },
    { start: 1, end: 2 },
    { start: 6, end: 8 },
    { start: 2, end: 3 },
  ];
  assert.deepEqual(planCut(ranges, 10, 'remove'), {
    kept: [
      { start: 0, end: 1 },
      { start: 3, end: 5 },
      { start: 8, end: 10 },
    ],
    removed: [
      { start: 1, end: 3 },
      { start: 5, end: 8 },
    ],
  });
  assert.deepEqual(planCut(ranges, 10, 'keep').kept, [
    { start: 1, end: 3 },
    { start: 5, end: 8 },
  ]);
  // 开放结尾、误差内的结尾截断到时长
  assert.deepEqual(planCut([{ start: 4 }, { start: 1, end: 2.03 }], 5, 'keep').kept, [
    { start: 1, end: 2.03 },
    { start: 4, end: 5 },
  ]);
  assert.deepEqual(planCut([{ start: 3, end: 4.04 }], 4, 'keep').kept, [{ start: 3, end: 4 }]);
});

test('planCut 的越界和空结果', () => {
  assert.throws(
    () =>
      planCut(
        [
          { start: 1, end: 2 },
          { start: 12, end: 13 },
        ],
        10,
        'remove',
      ),
    /ranges 第 2 个区间的开始时间 12 秒超出了时长 10 秒/,
  );
  assert.throws(
    () => planCut([{ start: 5, end: 11 }], 10, 'remove'),
    /ranges 第 1 个区间的结束时间 11 秒超出了时长 10 秒/,
  );
  assert.throws(() => planCut([{ start: 0 }], 10, 'remove'), /删除这些区间后没有剩余内容/);
});

test('参数校验', () => {
  assert.deepEqual(paramErrors(cutOperation, {}), [
    '请提供 ranges，应为 开始-结束，如 10-20 或 00:00:10-00:00:20，结束可省略表示到结尾（如 35-）',
  ]);
  assert.deepEqual(paramErrors(cutOperation, { ranges: '10-5' }), [
    'ranges 第 1 个区间的结束时间必须大于开始时间',
  ]);
  assert.deepEqual(paramErrors(cutOperation, { ranges: '1-2', mode: 'delete' }), [
    'mode 只能是 remove / keep',
  ]);
  assert.deepEqual(paramErrors(cutOperation, { ranges: '1-2', mode: 'KEEP' }), []);
});

test('remove：删掉中间两段，剩下的按顺序拼接', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(cutOperation, { file: [ramp] }, { ranges: '1-2,4-6' });
  try {
    assert.deepEqual(result.data, {
      mode: 'remove',
      kept: [
        { start: 0, end: 1 },
        { start: 2, end: 4 },
        { start: 6, end: 8 },
      ],
      removed: [
        { start: 1, end: 2 },
        { start: 4, end: 6 },
      ],
      duration: 5,
    });
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.ok(near(info.duration, 5, 0.1), `时长 ${info.duration}`);
    // 输出 0.5 秒 = 原片 0.5 秒；1.5 秒 = 原片 2.5 秒；3.5 秒 = 原片 6.5 秒
    assert.ok(near(frameLuma(out, 0.5), rampLuma(0.5), 8), `luma ${frameLuma(out, 0.5)}`);
    assert.ok(near(frameLuma(out, 1.5), rampLuma(2.5), 8), `luma ${frameLuma(out, 1.5)}`);
    assert.ok(near(frameLuma(out, 3.5), rampLuma(6.5), 8), `luma ${frameLuma(out, 3.5)}`);
    // 原片前 3 秒有声音：输出 0-2 秒有声音（原片 0-1、2-3），之后静音
    assert.ok(meanVolumeDb(out, 1.2, 0.6) > -40);
    assert.ok(meanVolumeDb(out, 3.2, 1) < -60);
  } finally {
    await ctx.cleanup();
  }
});

test('keep：只保留两段，只解码需要的范围', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(
    cutOperation,
    { file: [ramp] },
    { ranges: [{ start: '00:00:05', end: 6 }, '2-3'], mode: 'keep' },
  );
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.ok(near(info.duration, 2, 0.1), `时长 ${info.duration}`);
    // 按时间顺序：先 2-3 秒，再 5-6 秒
    assert.ok(near(frameLuma(out, 0.5), rampLuma(2.5), 8), `luma ${frameLuma(out, 0.5)}`);
    assert.ok(near(frameLuma(out, 1.5), rampLuma(5.5), 8), `luma ${frameLuma(out, 1.5)}`);
  } finally {
    await ctx.cleanup();
  }
});

test('单段 keep、没有音轨的视频、纯音频', { skip: ffmpegSkip }, async () => {
  const single = await runOperation(
    cutOperation,
    { file: [silent] },
    { ranges: '1-', mode: 'keep' },
  );
  try {
    const info = await probeMedia(single.result.files[0]);
    assert.equal(info.audio, undefined);
    assert.ok(near(info.duration, 3, 0.1), `时长 ${info.duration}`);
  } finally {
    await single.ctx.cleanup();
  }

  const wav = makeAudio(dir, 'a.wav', { duration: 3 });
  const audio = await runOperation(cutOperation, { file: [wav] }, { ranges: '0.5-1,2-2.5' });
  try {
    assert.ok(audio.result.files[0].endsWith('.m4a'));
    const info = await probeMedia(audio.result.files[0]);
    assert.equal(info.video, undefined);
    assert.ok(near(info.duration, 2, 0.1), `时长 ${info.duration}`);
  } finally {
    await audio.ctx.cleanup();
  }
});

test('区间超出时长时报错', { skip: ffmpegSkip }, async () => {
  await assert.rejects(
    runOperation(cutOperation, { file: [silent] }, { ranges: '1-2,3-9' }),
    /ranges 第 2 个区间的结束时间 9 秒超出了时长 4 秒/,
  );
});
