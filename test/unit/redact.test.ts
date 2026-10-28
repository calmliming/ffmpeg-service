import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { config } from '../../src/config';
import { redactPaths } from '../../src/utils/redact';

test('redactPaths：去掉 Windows 和 Linux 绝对路径的目录部分，只留文件名', () => {
  assert.equal(
    redactPaths(
      'D:\\Projects\\tools\\ffmpeg-service\\uploads\\2edf.mp4: Invalid data found when processing input',
    ),
    '2edf.mp4: Invalid data found when processing input',
  );
  assert.equal(
    redactPaths('/app/uploads/abc/in.mp4: No such file or directory'),
    'in.mp4: No such file or directory',
  );
  assert.equal(
    redactPaths("Error opening output '/app/output/x/seg_%03d.ts'"),
    "Error opening output 'seg_%03d.ts'",
  );
});

test('redactPaths：URL、比例、时间等普通文本不受影响', () => {
  for (const text of [
    '下载失败 https://example.com/a/b.mp4: HTTP 404',
    'aspect 16:9 / 4:3',
    'Duration: 00:01:02.50, bitrate: 128 kb/s',
    'Stream #0:1 -> #0:1 (aac (native) -> aac (native))',
    '输入没有画面，纯音频请用 /api/audio/normalize',
    '见 GET /api/operations',
  ]) {
    assert.equal(redactPaths(text), text);
  }
});

test('redactPaths：已知目录（可能含空格）整体去掉', () => {
  const work = path.join(config.uploadDir, 'task with space');
  assert.equal(
    redactPaths(`${path.join(work, 'meta.txt')}: Permission denied`, [work]),
    'meta.txt: Permission denied',
  );
  // 已知目录下的子目录（任务目录）也一起去掉，不留下 <taskId>\
  assert.equal(
    redactPaths(`${path.join(config.uploadDir, 'b1c2', 'input-0.txt')}: Invalid data`),
    'input-0.txt: Invalid data',
  );
});
