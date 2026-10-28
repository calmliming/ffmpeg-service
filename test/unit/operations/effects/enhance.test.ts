import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegSkip, generate, makeTempDir, makeVideo } from '../../../helpers/media';
import { paramErrors, runOperation } from '../../../helpers/op-context';
import { enhance, enhanceFilters } from '../../../../src/operations/effects/enhance';
import { probeMedia } from '../../../../src/utils/media-probe';
import { psnr } from './fixtures';

let dir = '';
let clean = '';
let noisy = '';
before(() => {
  if (ffmpegSkip) return;
  dir = makeTempDir('ffsvc-enhance-');
  clean = makeVideo(dir, 'clean.mp4', { size: '320x240', duration: 2, audio: false });
  noisy = path.join(dir, 'noisy.mp4');
  // 加时域随机噪点，再用很高的码率编码，尽量保住噪点
  generate([
    '-i',
    clean,
    '-vf',
    'noise=alls=30:allf=t',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '10',
    noisy,
  ]);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('enhanceFilters：固定顺序 去隔行 → 降噪 → 去色带 → 锐化', () => {
  const filters = enhanceFilters({
    denoise: 'light',
    sharpen: 0.5,
    deinterlace: true,
    deband: true,
  });
  assert.equal(filters.length, 4);
  assert.match(filters[0], /^bwdif=/);
  assert.match(filters[1], /^hqdn3d=luma_spatial=2:/);
  assert.equal(filters[2], 'deband');
  assert.match(filters[3], /^unsharp=.*luma_amount=0\.5:/);
});

test('enhance：降噪后更接近干净的原片；无音轨输入不产生音轨', { skip: ffmpegSkip }, async () => {
  const { result, ctx } = await runOperation(enhance, { file: [noisy] }, { denoise: 'strong' });
  try {
    const out = result.files[0];
    const info = await probeMedia(out);
    assert.equal(info.video?.width, 320);
    assert.equal(info.video?.height, 240);
    assert.equal(info.audio, undefined);
    const before = psnr(clean, noisy);
    const after = psnr(clean, out);
    assert.ok(after > before + 1, `降噪前 ${before} dB，降噪后 ${after} dB`);
  } finally {
    await ctx.cleanup();
  }
});

test('enhance：全部选项同时开启，时长和音轨保持', { skip: ffmpegSkip }, async () => {
  const video = makeVideo(dir, 'with-audio.mp4', { duration: 2 });
  const { result, ctx } = await runOperation(
    enhance,
    { file: [video] },
    { denoise: 'medium', sharpen: '1', deinterlace: 'true', deband: '1' },
  );
  try {
    const info = await probeMedia(result.files[0]);
    assert.ok(Math.abs(info.duration - 2) < 0.15);
    assert.equal(info.audio?.codec, 'aac');
    // 去隔行用 send_frame 模式，帧率不变
    assert.equal(info.video?.frameRate, '25/1');
  } finally {
    await ctx.cleanup();
  }
});

test('enhance：参数校验', () => {
  assert.deepEqual(paramErrors(enhance, {}), [
    '至少需要开启一项：denoise、sharpen、deinterlace 或 deband',
  ]);
  assert.deepEqual(paramErrors(enhance, { denoise: 'none', sharpen: 0 }), [
    '至少需要开启一项：denoise、sharpen、deinterlace 或 deband',
  ]);
  assert.deepEqual(paramErrors(enhance, { sharpen: 3 }), ['sharpen 必须是 0 到 2 之间的数字']);
  assert.deepEqual(paramErrors(enhance, { denoise: 'ultra' }), [
    'denoise 只能是 none / light / medium / strong',
  ]);
  assert.deepEqual(paramErrors(enhance, { deinterlace: 'yes' }), []);
});
