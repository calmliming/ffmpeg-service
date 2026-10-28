import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seekPlans, type VideoInfo } from '../../../../src/operations/visual/shared';

function info(fastSeek: boolean): VideoInfo {
  return { duration: 100, videoDuration: 100, width: 320, height: 240, fps: 25, sar: 1, fastSeek };
}

test('seekPlans：有索引的容器直接跳到目标', () => {
  assert.deepEqual(seekPlans(info(true), 42.5), [{ seek: 42.5, offset: 0, guard: false }]);
  // 时间为 0 不定位（单张图片当视频传入时加 -ss 0 反而读不到帧）
  assert.deepEqual(seekPlans(info(true), 0), [{ seek: 0, offset: 0, guard: false }]);
  assert.deepEqual(seekPlans(info(false), 0), [{ seek: 0, offset: 0, guard: false }]);
});

test('seekPlans：没有索引的容器先粗跳到目标之前并校验，最后从头解码', () => {
  const plans = seekPlans(info(false), 75.25);
  assert.deepEqual(
    plans.map((p) => ({ seek: p.seek, guard: p.guard })),
    [
      { seek: 65.25, guard: true },
      { seek: 15.25, guard: true },
      { seek: 0, guard: false },
    ],
  );
  // 偏移加跳转点总是目标时间
  for (const plan of plans) assert.ok(Math.abs(plan.seek + plan.offset - 75.25) < 1e-9);
  // 跳转点按 ffmpeg 参数的三位小数取整，偏移跟着取整后的跳转点走
  const [first] = seekPlans(info(false), 12.34567);
  assert.equal(first.seek, 2.346);
  assert.ok(Math.abs(first.offset - (12.34567 - 2.346)) < 1e-9);
  // 目标在 10 秒以内：只能从头解码
  assert.deepEqual(seekPlans(info(false), 7), [{ seek: 0, offset: 7, guard: false }]);
});
