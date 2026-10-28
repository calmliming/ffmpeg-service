import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../../../src/config';
import {
  checkStorage,
  contentTypeFor,
  defaultStorageSettings,
  deleteStoredOutputs,
  encodeUrlPath,
  localFileUrl,
  objectKey,
  relativeOutputPath,
  storeOutputs,
  type StorageSettings,
} from '../../../src/services/storage.service';
import { makeTempDir } from '../../helpers/media';

function localSettings(outputRoot: string, publicBaseUrl = ''): StorageSettings {
  return {
    ...defaultStorageSettings(),
    outputRoot,
    publicBaseUrl,
    s3: { ...config.s3, bucket: '' },
  };
}

function writeFile(root: string, relative: string, bytes: number): string {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

test('relativeOutputPath 用正斜杠，默认相对 config.outputDir', () => {
  const file = path.join(config.outputDir, 'abc', 'seg 1.ts');
  assert.equal(relativeOutputPath(file), 'abc/seg 1.ts');
  assert.equal(relativeOutputPath(path.join('/x', 'y', 'z.mp4'), path.join('/x')), 'y/z.mp4');
});

test('地址按段编码，保留目录分隔符', () => {
  assert.equal(encodeUrlPath('a b/c#d?e/中文.mp4'), 'a%20b/c%23d%3Fe/%E4%B8%AD%E6%96%87.mp4');
  assert.equal(localFileUrl('x/y z.m3u8', ''), '/api/files/x/y%20z.m3u8');
  assert.equal(
    localFileUrl('x/y.mp4', 'https://media.example.com'),
    'https://media.example.com/api/files/x/y.mp4',
  );
});

test('objectKey 拼前缀，空前缀不留斜杠', () => {
  assert.equal(objectKey('a/b.mp4', ''), 'a/b.mp4');
  assert.equal(objectKey('a/b.mp4', 'ffmpeg/out'), 'ffmpeg/out/a/b.mp4');
});

test('contentTypeFor 覆盖视频、音频、图片、字幕、播放列表和数据文件', () => {
  const expected: Record<string, string> = {
    'a.mp4': 'video/mp4',
    'a.MOV': 'video/quicktime',
    'a.mkv': 'video/x-matroska',
    'a.webm': 'video/webm',
    'a.ts': 'video/mp2t',
    'a.m4s': 'video/iso.segment',
    'a.mp3': 'audio/mpeg',
    'a.m4a': 'audio/mp4',
    'a.wav': 'audio/wav',
    'a.flac': 'audio/flac',
    'a.opus': 'audio/ogg',
    'a.ogg': 'audio/ogg',
    'a.aac': 'audio/aac',
    'a.png': 'image/png',
    'a.jpg': 'image/jpeg',
    'a.gif': 'image/gif',
    'a.webp': 'image/webp',
    'a.apng': 'image/apng',
    'a.srt': 'application/x-subrip',
    'a.vtt': 'text/vtt',
    'a.ass': 'text/x-ssa',
    'a.m3u8': 'application/vnd.apple.mpegurl',
    'a.mpd': 'application/dash+xml',
    'a.json': 'application/json',
    'a.txt': 'text/plain',
    'a.zip': 'application/zip',
  };
  for (const [file, type] of Object.entries(expected))
    assert.equal(contentTypeFor(file), type, file);
  // 不认识的、可在浏览器里执行脚本的类型一律按二进制下载
  assert.equal(contentTypeFor('a.svg'), 'application/octet-stream');
  assert.equal(contentTypeFor('a.html'), 'application/octet-stream');
  assert.equal(contentTypeFor('noext'), 'application/octet-stream');
});

test('本地模式：返回真实大小、类型和编码后的地址，顺序与输入一致', async () => {
  const root = makeTempDir('ffsvc-storage-');
  try {
    const video = writeFile(root, 'v1.mp4', 1234);
    const playlist = writeFile(root, 'hls dir/index.m3u8', 50);
    const segment = writeFile(root, 'hls dir/段 0.ts', 4096);
    const stored = await storeOutputs([segment, video, playlist, video], {
      taskId: 't1',
      settings: localSettings(root),
    });
    assert.equal(stored.length, 4);
    assert.deepEqual(
      stored.map((s) => [s.url, s.size, s.contentType, s.storage]),
      [
        ['/api/files/hls%20dir/%E6%AE%B5%200.ts', 4096, 'video/mp2t', 'local'],
        ['/api/files/v1.mp4', 1234, 'video/mp4', 'local'],
        ['/api/files/hls%20dir/index.m3u8', 50, 'application/vnd.apple.mpegurl', 'local'],
        ['/api/files/v1.mp4', 1234, 'video/mp4', 'local'],
      ],
    );
    assert.equal(stored[1].path, path.resolve(video));
    assert.equal(stored[0].key, undefined);
    assert.ok(fs.existsSync(segment), '本地模式不能删文件');

    const absolute = await storeOutputs([video], {
      taskId: 't1',
      settings: localSettings(root, 'https://media.example.com'),
    });
    assert.equal(absolute[0].url, 'https://media.example.com/api/files/v1.mp4');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('本地模式：输出目录外的文件、不存在的文件、目录都报中文错误且不泄露绝对路径', async () => {
  const root = makeTempDir('ffsvc-storage-');
  const outside = makeTempDir('ffsvc-storage-out-');
  try {
    const settings = localSettings(root);
    const stray = writeFile(outside, 'secret.mp4', 10);
    await assert.rejects(storeOutputs([stray], { taskId: 't', settings }), (err: Error) => {
      assert.equal(err.message, '产物不在输出目录内: secret.mp4');
      return true;
    });
    await assert.rejects(
      storeOutputs([path.join(root, 'missing.mp4')], { taskId: 't', settings }),
      { message: '产物文件不存在: missing.mp4' },
    );
    fs.mkdirSync(path.join(root, 'dir'));
    await assert.rejects(storeOutputs([path.join(root, 'dir')], { taskId: 't', settings }), {
      message: '产物不是普通文件: dir',
    });
    await assert.rejects(storeOutputs([root], { taskId: 't', settings }), {
      message: `产物不在输出目录内: ${path.basename(root)}`,
    });
    assert.deepEqual(await storeOutputs([], { taskId: 't', settings }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('已取消的任务直接以 signal.reason 拒绝', async () => {
  const root = makeTempDir('ffsvc-storage-');
  try {
    const file = writeFile(root, 'a.mp4', 1);
    const controller = new AbortController();
    const reason = new Error('任务已取消');
    controller.abort(reason);
    await assert.rejects(
      storeOutputs([file], {
        taskId: 't',
        signal: controller.signal,
        settings: localSettings(root),
      }),
      (err) => err === reason,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteStoredOutputs 本地模式：删除产物和变空的子目录，不碰输出目录以外的文件', async () => {
  const root = makeTempDir('ffsvc-storage-');
  const outside = makeTempDir('ffsvc-storage-out-');
  try {
    const settings = localSettings(root);
    const keep = writeFile(root, 'other/keep.mp4', 5);
    const files = [writeFile(root, 'job/v0/seg.ts', 10), writeFile(root, 'job/index.m3u8', 10)];
    const stored = await storeOutputs(files, { taskId: 't', settings });
    const stray = writeFile(outside, 'x.mp4', 1);
    await deleteStoredOutputs([...stored, { ...stored[0], path: stray }], {
      taskId: 't',
      settings,
    });
    assert.ok(!fs.existsSync(path.join(root, 'job')), '产物和空目录都已删除');
    assert.ok(fs.existsSync(keep), '其他任务的产物保留');
    assert.ok(fs.existsSync(stray), '输出目录以外的文件不删');
    assert.ok(fs.existsSync(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('checkStorage 本地模式检查输出目录', async () => {
  const root = makeTempDir('ffsvc-storage-');
  try {
    assert.deepEqual(await checkStorage({ settings: localSettings(root) }), {
      driver: 'local',
      ok: true,
    });
    const missing = await checkStorage({ settings: localSettings(path.join(root, 'nope')) });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /^输出目录不可写/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
