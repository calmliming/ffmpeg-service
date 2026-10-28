import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  runRetentionSweep,
  startOutputRetentionSweeper,
  sweepExpired,
} from '../../../src/services/storage.service';
import { makeTempDir } from '../../helpers/media';

const HOUR = 60 * 60 * 1000;

function write(file: string, bytes: number, ageHours: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  age(file, ageHours);
}

function age(target: string, ageHours: number): void {
  const when = new Date(Date.now() - ageHours * HOUR);
  fs.utimesSync(target, when, when);
}

test('sweepExpired 删除过期文件和整个过期目录，保留新的和占位文件', async () => {
  const dir = makeTempDir('ffsvc-sweep-');
  try {
    write(path.join(dir, 'old.mp4'), 1000, 30);
    write(path.join(dir, 'fresh.mp4'), 10, 1);
    write(path.join(dir, '.gitkeep'), 0, 100);

    // 目录里全是旧文件 → 整个删除（目录 mtime 在创建文件后再改）
    const oldDir = path.join(dir, 'old-hls');
    write(path.join(oldDir, 'index.m3u8'), 100, 50);
    write(path.join(oldDir, 'v0', 'seg_000.ts'), 2000, 50);
    age(path.join(oldDir, 'v0'), 50);
    age(oldDir, 50);

    // 目录里有一个新文件 → 按最新文件算，保留
    const mixedDir = path.join(dir, 'mixed');
    write(path.join(mixedDir, 'a.ts'), 500, 50);
    write(path.join(mixedDir, 'deep', 'b.ts'), 500, 2);
    age(path.join(mixedDir, 'deep'), 50);
    age(mixedDir, 50);

    // 目录自身是新的（刚创建的任务目录，里面只有硬链接进来的旧字体）→ 保留
    const freshDir = path.join(dir, 'task-work');
    write(path.join(freshDir, 'font.ttc'), 300, 5000);

    // 空的旧目录也删
    fs.mkdirSync(path.join(dir, 'empty-old'));
    age(path.join(dir, 'empty-old'), 30);

    const stats = await sweepExpired(dir, Date.now() - 24 * HOUR);
    assert.deepEqual(stats, { removed: 3, bytes: 1000 + 100 + 2000, failed: 0 });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.gitkeep', 'fresh.mp4', 'mixed', 'task-work']);
    assert.ok(fs.existsSync(path.join(mixedDir, 'a.ts')), '目录只能整体删除，不能删掉其中的旧文件');

    // 再扫一次没有可删的
    assert.deepEqual(await sweepExpired(dir, Date.now() - 24 * HOUR), {
      removed: 0,
      bytes: 0,
      failed: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepExpired 截止时间之后的条目都保留，目录不存在时返回 0', async () => {
  const dir = makeTempDir('ffsvc-sweep-');
  try {
    write(path.join(dir, 'a.mp4'), 10, 47);
    assert.equal((await sweepExpired(dir, Date.now() - 48 * HOUR)).removed, 0);
    assert.equal((await sweepExpired(dir, Date.now() - 46 * HOUR)).removed, 1);
    assert.deepEqual(await sweepExpired(path.join(dir, 'missing'), Date.now()), {
      removed: 0,
      bytes: 0,
      failed: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runRetentionSweep：产物按保留小时数清理，uploads 残留固定 48 小时', async () => {
  const outputDir = makeTempDir('ffsvc-sweep-out-');
  const uploadDir = makeTempDir('ffsvc-sweep-up-');
  try {
    write(path.join(outputDir, 'a.mp4'), 100, 30);
    write(path.join(outputDir, 'b.mp4'), 100, 10);
    write(path.join(uploadDir, 'orphan-upload'), 50, 49);
    write(path.join(uploadDir, 'task-1', 'in.mp4'), 70, 60);
    age(path.join(uploadDir, 'task-1'), 60);
    write(path.join(uploadDir, 'queued-upload'), 10, 30);

    // 0 小时：产物永久保留，uploads 仍然清理
    const kept = await runRetentionSweep({ outputDir, uploadDir, retentionHours: 0 });
    assert.equal(kept.output, null);
    assert.deepEqual(kept.uploads, { removed: 2, bytes: 120, failed: 0 });
    assert.deepEqual(fs.readdirSync(uploadDir), ['queued-upload']);
    assert.equal(fs.readdirSync(outputDir).length, 2);

    const swept = await runRetentionSweep({ outputDir, uploadDir, retentionHours: 24 });
    assert.deepEqual(swept.output, { removed: 1, bytes: 100, failed: 0 });
    assert.deepEqual(fs.readdirSync(outputDir), ['b.mp4']);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

test('startOutputRetentionSweeper 返回停止函数，定时器不阻止进程退出', () => {
  const stop = startOutputRetentionSweeper();
  assert.equal(typeof stop, 'function');
  stop();
  stop();
});
