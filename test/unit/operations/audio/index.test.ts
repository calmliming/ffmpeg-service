import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { z } from 'zod';
import { operations } from '../../../../src/operations/audio';

const EXPECTED = [
  'audio.convert',
  'audio.normalize',
  'video.normalize-audio',
  'audio.denoise',
  'audio.trim-silence',
  'audio.volume',
  'audio.fade',
  'audio.speed',
  'audio.trim',
  'audio.reverse',
  'audio.concat',
  'audio.mix',
  'audio.waveform',
  'audio.spectrogram',
];

test('音频组导出全部操作，名称和路由一一对应', () => {
  assert.deepEqual(
    operations.map((op) => op.name),
    EXPECTED,
  );
  for (const op of operations) {
    const [group, action] = op.name.split('.');
    assert.equal(op.route, `/api/${group}/${action}`, op.name);
  }
});

test('单文件操作可串联，多文件操作不可串联', () => {
  for (const op of operations) {
    const required = op.inputs.filter((slot) => slot.required);
    const single = required.length === 1 && required[0].name === 'file' && !required[0].multiple;
    assert.equal(op.chainable === true, single, op.name);
  }
});

test('文档元数据完整：标题、说明、示例、每个参数的中文说明', () => {
  for (const op of operations) {
    assert.ok(op.title && op.description, op.name);
    assert.ok(op.example?.includes('http://localhost:9527' + op.route), `${op.name} 的示例`);
    assert.ok((op.notes ?? []).length > 0, `${op.name} 的 notes`);
    for (const slot of op.inputs) assert.ok(slot.description, `${op.name}.${slot.name}`);
    for (const [key, schema] of Object.entries(op.params.shape)) {
      const meta = (schema as z.ZodType).meta();
      assert.ok(
        typeof meta?.description === 'string' && /[一-龥]/.test(meta.description),
        `${op.name} 的参数 ${key} 缺少中文说明`,
      );
    }
  }
});

test('所有参数都可以不传或有默认值（空字符串按没传处理）', () => {
  for (const op of operations) {
    const parsed = op.params.safeParse({});
    assert.ok(parsed.success, `${op.name}: ${parsed.success ? '' : parsed.error.message}`);
  }
});
