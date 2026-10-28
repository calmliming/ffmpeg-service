import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { cleanupRoot, fileBlob, getJson, postForm, uploadDir, waitForEmptyDir } from './harness';
import { allOps } from './fake-ops';
import { createApp } from '../../../src/app';
import type { TaskService } from '../../../src/services/task.service';

// 客户端在上传途中断开（超时、Ctrl+C、网络中断）时，multer 2 在 req.files 里放的是还没有 path 的占位对象。
// 这些用例不经过任务队列：断开发生在解析请求体期间，所以用桩代替 Redis

const BOUNDARY = 'ABORTBOUNDARY';
let server: http.Server;
let port = 0;
let base = '';
const uncaught: unknown[] = [];
const onUncaught = (err: unknown) => uncaught.push(err);

before(async () => {
  process.on('uncaughtException', onUncaught);
  const tasks = { ping: async () => true } as unknown as TaskService;
  const queue = {
    add: async () => {
      throw new Error('不应入队');
    },
    getJobCounts: async () => ({}),
  };
  server = createApp({ operations: allOps, tasks, queue: queue as never }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  process.off('uncaughtException', onUncaught);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  cleanupRoot();
});

const filePart = (name: string, filename: string) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
  'Content-Type: video/mp4\r\n\r\n';
const fieldPart = (name: string) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`;

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 发一个声明了很大 Content-Length 的 multipart 请求，写完 pieces 后（可选地等到上传目录里出现文件）直接销毁连接。
 * 返回服务器在断开前是否回过任何字节
 */
async function abortUpload(
  route: string,
  pieces: (string | Buffer)[],
  opts: { waitForFiles?: number } = {},
): Promise<string> {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  let received = '';
  socket.on('data', (d) => (received += d.toString()));
  socket.on('error', () => {});
  socket.write(
    `POST ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\n` +
      `Content-Length: ${200 * 1024 * 1024}\r\n\r\n`,
  );
  for (const piece of pieces) {
    if (!socket.write(piece)) await once(socket, 'drain');
  }
  if (opts.waitForFiles) {
    await waitUntil(() => fs.readdirSync(uploadDir).length >= opts.waitForFiles!);
  }
  // 给服务器一点时间处理已经发出的数据，再像客户端超时那样掐断
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  return received;
}

async function assertServerHealthy(label: string): Promise<void> {
  assert.deepEqual(uncaught, [], `${label}: 不应出现未捕获的异常`);
  const list = await getJson(`${base}/api/operations`);
  assert.equal(list.status, 200, `${label}: 断开后服务应继续响应`);
  assert.deepEqual(await waitForEmptyDir(uploadDir), [], `${label}: 半截上传文件应被删除`);
}

const MB = Buffer.alloc(1024 * 1024, 7);

test('上传中途断开：文件写到一半时断开，进程不崩溃、半截文件被删除，下一个请求正常处理', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await abortUpload('/api/test/copy', [filePart('file', 'clip.mp4'), MB, MB], {
      waitForFiles: 1,
    });
    await assertServerHealthy('文件中途');

    // 多文件槽：第一个文件已经写完，第二个写到一半
    await abortUpload(
      '/api/test/multi',
      [filePart('files', 'a.mp4'), MB, '\r\n', filePart('files', 'b.mp4'), MB],
      { waitForFiles: 2 },
    );
    await assertServerHealthy('第二个文件中途');

    // 文本字段写到一半
    await abortUpload('/api/test/copy', [fieldPart('repeat'), '1']);
    await assertServerHealthy('字段中途');

    // 文件已经完整，下一个 part 还没开始
    await abortUpload('/api/test/copy', [
      filePart('file', 'clip.mp4'),
      MB,
      `\r\n--${BOUNDARY}\r\n`,
    ]);
    await assertServerHealthy('两个 part 之间');

    // 只发了请求头和 part 头，文件内容一个字节都没到
    await abortUpload('/api/test/copy', [filePart('file', 'clip.mp4')]);
    await assertServerHealthy('文件刚开始');
  } finally {
    console.warn = warn;
  }

  // 断开这么多次之后，正常的上传仍然能处理（同步操作不需要 Redis）
  const form = new FormData();
  form.append('file', fileBlob(MB, 'video/mp4'), 'clip.mp4');
  const res = await postForm(`${base}/api/test/sync`, form);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { size: MB.length });
  assert.deepEqual(await waitForEmptyDir(uploadDir), []);
  assert.deepEqual(uncaught, []);
});
