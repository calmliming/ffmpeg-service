import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { config } from '../../src/config';
import {
  createUploadMiddleware,
  isAllowedForKind,
  uploadedFilesBySlot,
} from '../../src/middleware/upload';
import { errorHandler } from '../../src/middleware/error';
import type { InputSlot } from '../../src/operations/types';

const original = { uploadDir: config.uploadDir, maxFileSize: config.maxFileSize };
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsvc-upload-'));
let server: http.Server;
let port = 0;

const SLOTS: InputSlot[] = [
  { name: 'file', kind: 'video', required: true, description: '视频' },
  {
    name: 'tracks',
    kind: 'audio',
    required: false,
    multiple: { min: 1, max: 2 },
    description: '音轨',
  },
  { name: 'subtitle', kind: 'subtitle', required: false, description: '字幕' },
];

/** 像 transcode 这样只有一个单文件槽的接口 */
const SINGLE: InputSlot[] = [{ name: 'file', kind: 'video', required: true, description: '视频' }];

before(async () => {
  config.uploadDir = uploadDir;
  // 1 MB 上限，8 MB 的测试文件一定超
  config.maxFileSize = 1024 * 1024;
  const app = express();
  const respond: express.RequestHandler = (req, res) => {
    const files = uploadedFilesBySlot(req);
    const saved = Object.fromEntries(
      Object.entries(files).map(([slot, list]) => [slot, list.map((f) => path.basename(f.path))]),
    );
    // 测试只看落盘的文件名，看完就删
    for (const list of Object.values(files)) for (const f of list) fs.rmSync(f.path);
    res.json({ success: true, saved, fields: req.body });
  };
  app.post('/upload', createUploadMiddleware(SLOTS), respond);
  app.post('/single', createUploadMiddleware(SINGLE), respond);
  app.get('/ping', (_req, res) => {
    res.json({ success: true });
  });
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  config.uploadDir = original.uploadDir;
  config.maxFileSize = original.maxFileSize;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

interface Part {
  name: string;
  value?: string;
  file?: { filename: string; type: string; size: number };
}

/** 手写 multipart，文件内容分块发送，像多数客户端一样把请求体发完再读响应 */
function send(parts: Part[], agent: http.Agent, route = '/upload') {
  const boundary = 'TESTBOUNDARY';
  const chunk = Buffer.alloc(256 * 1024, 1);
  const pieces: Buffer[] = [];
  for (const part of parts) {
    if (part.file) {
      pieces.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.file.filename}"\r\nContent-Type: ${part.file.type}\r\n\r\n`,
        ),
      );
      for (let left = part.file.size; left > 0; left -= chunk.length) {
        pieces.push(left >= chunk.length ? chunk : chunk.subarray(0, left));
      }
      pieces.push(Buffer.from('\r\n'));
    } else {
      pieces.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ''}\r\n`,
        ),
      );
    }
  }
  pieces.push(Buffer.from(`--${boundary}--\r\n`));
  const total = pieces.reduce((sum, p) => sum + p.length, 0);

  return new Promise<{ status: number; body: Record<string, unknown> & { error?: string } }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: route,
          agent,
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': total,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      for (const piece of pieces) req.write(piece);
      req.end();
    },
  );
}

const MB8 = 8 * 1024 * 1024;
const fileOf = (name: string, filename: string, type: string, size = 1024): Part => ({
  name,
  file: { filename, type, size },
});

function ping(agent: http.Agent) {
  return new Promise<{ status: number; reused: boolean }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/ping', agent }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
    });
    req.on('error', reject);
  });
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

/** multer 删除被拒文件是异步的 */
async function uploadDirEntries(): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const entries = fs.readdirSync(uploadDir);
    if (entries.length === 0 || Date.now() > deadline) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('upload：按槽落盘，文件名是 UUID 加小写扩展名，奇怪的扩展名被丢掉', async () => {
  const agent = new http.Agent({ keepAlive: false });
  try {
    const result = await send(
      [
        fileOf('file', 'Clip.MP4', 'application/octet-stream'),
        fileOf('tracks', 'a.mp3', 'audio/mpeg'),
        fileOf('tracks', 'b.weird-extension', 'audio/wav'),
        fileOf('subtitle', 'sub.srt', 'application/x-subrip'),
        { name: 'speed', value: '2' },
      ],
      agent,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const saved = result.body.saved as Record<string, string[]>;
    assert.match(saved.file[0], /^[0-9a-f-]{36}\.mp4$/);
    assert.equal(saved.tracks.length, 2);
    assert.match(saved.tracks[1], /^[0-9a-f-]{36}$/);
    assert.match(saved.subtitle[0], /\.srt$/);
    assert.deepEqual(result.body.fields, { speed: '2' });
  } finally {
    agent.destroy();
  }
});

test('upload：文件类型不符合槽的类别返回 400，keep-alive 连接还能继续复用', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const result = await quietly(() =>
      send([fileOf('file', 'evil.exe', 'application/octet-stream', MB8)], agent),
    );
    assert.equal(result.status, 400);
    assert.equal(
      result.body.error,
      '不支持的文件类型: application/octet-stream（evil.exe），file 只接受视频文件',
    );
    const next = await ping(agent);
    assert.equal(next.status, 200);
    assert.equal(next.reused, true);
    assert.deepEqual(await uploadDirEntries(), []);

    const sub = await quietly(() => send([fileOf('subtitle', 'a.mp4', 'video/mp4')], agent));
    assert.equal(sub.status, 400);
    assert.match(sub.body.error!, /subtitle 只接受字幕（srt \/ ass \/ ssa \/ vtt）文件/);
  } finally {
    agent.destroy();
  }
});

test('upload：文件字段名不对返回 400 并列出本接口的字段，keep-alive 连接还能继续复用', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const result = await quietly(() =>
      send([fileOf('video', 'clip.mp4', 'video/mp4', MB8)], agent),
    );
    assert.equal(result.status, 400);
    assert.equal(
      result.body.error,
      '上传参数错误: 不接受文件字段 video，本接口的文件字段: file（最多 1 个）、tracks（最多 2 个）、subtitle（最多 1 个）',
    );
    const next = await ping(agent);
    assert.equal(next.status, 200);
    assert.equal(next.reused, true);
  } finally {
    agent.destroy();
  }
});

test('upload：同一槽的文件超过 multiple.max 返回 400，已落盘的文件被删除', async () => {
  const agent = new http.Agent({ keepAlive: false });
  try {
    const result = await quietly(() =>
      send(
        [
          fileOf('tracks', 'a.mp3', 'audio/mpeg'),
          fileOf('tracks', 'b.mp3', 'audio/mpeg'),
          fileOf('tracks', 'c.mp3', 'audio/mpeg'),
        ],
        agent,
      ),
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error, '上传参数错误: tracks 最多上传 2 个文件');
    assert.deepEqual(await uploadDirEntries(), []);
  } finally {
    agent.destroy();
  }
});

test('upload：单文件接口多传一个文件时，按字段说明是哪个字段多了或不被接受，而不是笼统的数量超限', async () => {
  const agent = new http.Agent({ keepAlive: false });
  try {
    // 同一个字段传两次
    const duplicate = await quietly(() =>
      send(
        [fileOf('file', 'a.mp4', 'video/mp4'), fileOf('file', 'b.mp4', 'video/mp4')],
        agent,
        '/single',
      ),
    );
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.body.error, '上传参数错误: file 最多上传 1 个文件');
    assert.deepEqual(await uploadDirEntries(), []);

    // 合法文件之外多了一个本接口不接受的字段（transcode 上传了 image）
    const extra = await quietly(() =>
      send(
        [fileOf('file', 'a.mp4', 'video/mp4'), fileOf('image', 'logo.png', 'image/png')],
        agent,
        '/single',
      ),
    );
    assert.equal(extra.status, 400);
    assert.equal(
      extra.body.error,
      '上传参数错误: 不接受文件字段 image，本接口的文件字段: file（最多 1 个）',
    );
    assert.deepEqual(await uploadDirEntries(), []);

    // 多槽接口：各槽都满了还多一个
    const full = await quietly(() =>
      send(
        [
          fileOf('file', 'a.mp4', 'video/mp4'),
          fileOf('tracks', 'a.mp3', 'audio/mpeg'),
          fileOf('tracks', 'b.mp3', 'audio/mpeg'),
          fileOf('subtitle', 'a.srt', 'application/x-subrip'),
          fileOf('logo', 'logo.png', 'image/png'),
        ],
        agent,
      ),
    );
    assert.equal(full.status, 400);
    assert.match(full.body.error!, /^上传参数错误: 不接受文件字段 logo，本接口的文件字段: file/);
    assert.deepEqual(await uploadDirEntries(), []);
  } finally {
    agent.destroy();
  }
});

test('upload：文件超过 MAX_UPLOAD_MB 返回 413，半截文件被删除', async () => {
  const agent = new http.Agent({ keepAlive: false });
  try {
    const result = await quietly(() =>
      send([fileOf('file', 'big.mp4', 'video/mp4', 3 * 1024 * 1024)], agent),
    );
    assert.equal(result.status, 413);
    assert.equal(result.body.error, '文件超过 1MB 上限');
    assert.deepEqual(await uploadDirEntries(), []);
  } finally {
    agent.destroy();
  }
});

test('upload：文本字段数量、嵌套深度、字段长度超限返回 400 而不是把内存或 CPU 吃满', async () => {
  const agent = new http.Agent({ keepAlive: false });
  try {
    // 上限是 50 个基础字段 + 多文件槽的 max（这里 2）
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `f${i}`, value: 'v' }));
    const tooMany = await quietly(() => send(many, agent));
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, '上传参数错误: 表单字段数量超过上限');

    const nested = await quietly(() => send([{ name: 'a[b][c]', value: '1' }], agent));
    assert.equal(nested.status, 400);
    assert.match(nested.body.error!, /嵌套过深/);

    const long = await quietly(() => send([{ name: 'text', value: 'x'.repeat(70 * 1024) }], agent));
    assert.equal(long.status, 400);
    assert.equal(long.body.error, '上传参数错误: 表单字段 text 的值超过 64 KB 上限');

    // 一层数组是允许的（timestamps[]）
    const array = await send(
      [
        { name: 'timestamps[]', value: '1' },
        { name: 'timestamps[]', value: '2' },
      ],
      agent,
    );
    assert.equal(array.status, 200, JSON.stringify(array.body));
    assert.deepEqual(array.body.fields, { timestamps: ['1', '2'] });
  } finally {
    agent.destroy();
  }
});

test('isAllowedForKind：MIME 和扩展名任一符合即放行，按槽的类别区分', () => {
  // Go / PHP / curl 默认发 octet-stream，靠扩展名放行
  assert.equal(isAllowedForKind('video', 'application/octet-stream', 'clip.MOV'), true);
  assert.equal(isAllowedForKind('video', 'video/mp4', 'blob'), true);
  assert.equal(isAllowedForKind('video', 'image/gif', 'anim'), true);
  assert.equal(isAllowedForKind('video', 'audio/mpeg', 'song.mp3'), false);
  assert.equal(isAllowedForKind('audio', 'application/octet-stream', 'song.FLAC'), true);
  assert.equal(isAllowedForKind('audio', 'video/mp4', 'clip.mp4'), false);
  assert.equal(isAllowedForKind('media', 'audio/wav', 'x'), true);
  assert.equal(isAllowedForKind('media', 'video/webm', 'x'), true);
  assert.equal(isAllowedForKind('media', 'image/png', 'a.png'), false);
  assert.equal(isAllowedForKind('image', 'application/octet-stream', 'logo.webp'), true);
  // curl -F file=@photo.avif 发的是 octet-stream；手机照片是 HEIC / HEIF
  for (const name of ['photo.avif', 'IMG_0001.HEIC', 'photo.heif', 'anim.apng']) {
    assert.equal(isAllowedForKind('image', 'application/octet-stream', name), true, name);
  }
  assert.equal(isAllowedForKind('video', 'application/octet-stream', 'photo.avif'), false);
  // SVG 是 XML，FFmpeg 解不了，也不该进输出目录
  assert.equal(isAllowedForKind('image', 'image/svg+xml', 'logo'), false);
  assert.equal(isAllowedForKind('subtitle', 'application/octet-stream', 'a.ass'), true);
  assert.equal(isAllowedForKind('subtitle', 'text/vtt', 'blob'), true);
  assert.equal(isAllowedForKind('subtitle', 'application/x-subrip', 'blob'), true);
  assert.equal(isAllowedForKind('subtitle', 'application/octet-stream', 'a.txt'), false);
  assert.equal(isAllowedForKind('any', 'application/octet-stream', 'a.srt'), true);
  assert.equal(isAllowedForKind('any', 'image/jpeg', 'x'), true);
  assert.equal(isAllowedForKind('any', 'application/x-msdownload', 'evil.exe'), false);
});
