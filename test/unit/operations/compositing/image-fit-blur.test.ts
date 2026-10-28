import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fitGraph } from '../../../../src/operations/compositing/image-fit';
import { ffmpegSkip, generate, makeTempDir } from '../../../helpers/media';

// boxblur 要求 2 × 半径 < 平面短边，输出画面很小（短边 < 6）时原来的色度半径 1 会让 FFmpeg 报 Invalid argument
test('fitGraph blur：极小和常见的输出尺寸都能生成', { skip: ffmpegSkip }, () => {
  const dir = makeTempDir();
  try {
    for (const [width, height] of [
      [4, 4],
      [1920, 4],
      [6, 6],
      [1280, 720],
    ]) {
      const out = path.join(dir, `fit-${width}x${height}.png`);
      const graph = fitGraph('0:v', 'blur', { width, height }, 'black');
      generate(
        ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1', '-filter_complex', graph].concat([
          '-map',
          '[out]',
          '-frames:v',
          '1',
          out,
        ]),
      );
      assert.ok(fs.statSync(out).size > 0, `${width}x${height}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
