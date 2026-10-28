import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { config } from '../../src/config';
import { downloadAll, downloadFile } from '../../src/utils/download';

const BODY = Buffer.alloc(256 * 1024, 7);
const FAST = { retryBaseDelayMs: 10, idleTimeoutMs: 2000 };

let server: http.Server;
let base = '';
let port = 0;
const originalAllowPrivate = config.allowPrivateUrls;
let dir = '';
const hits = new Map<string, number>();
let active = 0;
let maxActive = 0;

function sendBody(res: http.ServerResponse) {
  res.writeHead(200, { 'content-length': BODY.length, 'content-type': 'video/mp4' });
  res.end(BODY);
}

before(async () => {
  // 测试服务器在 127.0.0.1 上，默认会被 SSRF 防护拦下；需要验证拦截的用例里再临时关掉
  config.allowPrivateUrls = true;
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ffsvc-download-'));
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const n = (hits.get(pathname) ?? 0) + 1;
    hits.set(pathname, n);

    // /hop/<n>：再跳 n 次才返回文件
    const hop = /^\/hop\/(\d+)$/.exec(pathname);
    if (hop) {
      const left = Number(hop[1]);
      if (left === 0) return sendBody(res);
      res.writeHead(302, { location: `/hop/${left - 1}` });
      return res.end();
    }

    switch (pathname) {
      case '/ok':
        return sendBody(res);
      case '/flaky':
        // 前两次直接掐断连接，模拟 CDN 断开 TLS 握手
        if (n <= 2) return req.socket.destroy();
        return sendBody(res);
      case '/truncated':
        // 声明了完整长度但只发一部分就断开
        if (n === 1) {
          res.writeHead(200, { 'content-length': BODY.length });
          res.write(BODY.subarray(0, 1000));
          setTimeout(() => req.socket.destroy(), 20);
          return;
        }
        return sendBody(res);
      case '/brotli': {
        // 无视 accept-encoding: identity，返回一个解压后很大的 br 响应
        const bomb = zlib.brotliCompressSync(Buffer.alloc(8 * 1024 * 1024));
        res.writeHead(200, { 'content-encoding': 'br', 'content-length': bomb.length });
        return res.end(bomb);
      }
      case '/gzip-big': {
        const packed = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024));
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': packed.length });
        return res.end(packed);
      }
      case '/stall':
        // 第一次只发响应头然后一直不发数据
        if (n === 1) {
          res.writeHead(200, { 'content-length': BODY.length });
          res.write(BODY.subarray(0, 10));
          return;
        }
        return sendBody(res);
      case '/redirect':
        res.writeHead(302, { location: '/ok' });
        return res.end();
      case '/redirect-private':
        // 模拟公网地址把请求重定向到内网：第一跳放行，收到请求后才打开防护，下一跳必须被拦下
        config.allowPrivateUrls = false;
        res.writeHead(302, { location: `http://127.0.0.1:${port}/private-target` });
        return res.end();
      case '/redirect-metadata':
        config.allowPrivateUrls = false;
        res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case '/redirect-file':
        res.writeHead(302, { location: 'file:///etc/passwd' });
        return res.end();
      case '/private-target':
        return sendBody(res);
      case '/always-fail':
        return req.socket.destroy();
      case '/slow':
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active--;
          sendBody(res);
        }, 150);
        return;
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  config.allowPrivateUrls = originalAllowPrivate;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.promises.rm(dir, { recursive: true, force: true });
});

const exists = (file: string) => fs.existsSync(file);

/** 在 SSRF 防护打开的状态下执行 fn，结束后恢复本文件的默认（放行内网） */
async function withPrivateBlocked<T>(fn: () => Promise<T>): Promise<T> {
  config.allowPrivateUrls = false;
  try {
    return await fn();
  } finally {
    config.allowPrivateUrls = true;
  }
}

test('downloadFile：连接被掐断两次后重试成功，文件完整', async () => {
  const dest = path.join(dir, 'flaky.bin');
  const retries: number[] = [];
  const bytes = await downloadFile(`${base}/flaky`, dest, {
    ...FAST,
    retries: 3,
    onRetry: ({ attempt }) => retries.push(attempt),
  });
  assert.equal(bytes, BODY.length);
  assert.equal(fs.statSync(dest).size, BODY.length);
  assert.equal(hits.get('/flaky'), 3);
  assert.deepEqual(retries, [1, 2]);
});

test('downloadFile：响应中途断开会重试并拿到完整文件', async () => {
  const dest = path.join(dir, 'truncated.bin');
  await downloadFile(`${base}/truncated`, dest, { ...FAST, retries: 2 });
  assert.equal(fs.statSync(dest).size, BODY.length);
  assert.equal(hits.get('/truncated'), 2);
});

test('downloadFile：超过空闲超时收不到数据会重试', async () => {
  const dest = path.join(dir, 'stall.bin');
  await downloadFile(`${base}/stall`, dest, {
    retries: 1,
    retryBaseDelayMs: 10,
    idleTimeoutMs: 200,
  });
  assert.equal(fs.statSync(dest).size, BODY.length);
  assert.equal(hits.get('/stall'), 2);
});

test('downloadFile：404 不重试，错误里带状态码和地址', async () => {
  const dest = path.join(dir, 'missing.bin');
  await assert.rejects(
    downloadFile(`${base}/missing`, dest, { ...FAST, retries: 3 }),
    (err: Error) => {
      assert.match(err.message, /HTTP 404/);
      assert.match(err.message, /\/missing/);
      return true;
    },
  );
  assert.equal(hits.get('/missing'), 1);
  assert.equal(exists(dest), false);
});

test('downloadFile：跟随 302 跳转', async () => {
  const dest = path.join(dir, 'redirect.bin');
  await downloadFile(`${base}/redirect`, dest, { ...FAST, retries: 0 });
  assert.equal(fs.statSync(dest).size, BODY.length);
});

test('downloadFile：重试用尽后报错，不留下半截文件', async () => {
  const dest = path.join(dir, 'always-fail.bin');
  await assert.rejects(
    downloadFile(`${base}/always-fail`, dest, { ...FAST, retries: 2 }),
    /已重试 2 次/,
  );
  assert.equal(hits.get('/always-fail'), 3);
  assert.equal(exists(dest), false);
});

test('downloadFile：br 编码的响应直接拒绝且不重试，不留下文件', async () => {
  const dest = path.join(dir, 'brotli.bin');
  await assert.rejects(
    downloadFile(`${base}/brotli`, dest, { ...FAST, retries: 3 }),
    /不支持的 Content-Encoding: br/,
  );
  assert.equal(hits.get('/brotli'), 1);
  assert.equal(exists(dest), false);
});

test('downloadFile：解码后超过 maxBytes 立即中止且不重试', async () => {
  const dest = path.join(dir, 'gzip-big.bin');
  await assert.rejects(
    downloadFile(`${base}/gzip-big`, dest, { ...FAST, retries: 3, maxBytes: 1024 * 1024 }),
    /超过 1 MB 上限/,
  );
  assert.equal(hits.get('/gzip-big'), 1);
  assert.equal(exists(dest), false);
});

test('downloadFile：content-length 已超过 maxBytes 时不读响应体', async () => {
  const dest = path.join(dir, 'ok-capped.bin');
  await assert.rejects(
    downloadFile(`${base}/ok`, dest, { ...FAST, retries: 0, maxBytes: 1024 }),
    /上限/,
  );
  assert.equal(exists(dest), false);
});

test('downloadAll：同时在下载的文件数不超过并发上限', async () => {
  maxActive = 0;
  const jobs = Array.from({ length: 6 }, (_, i) => ({
    url: `${base}/slow`,
    dest: path.join(dir, `slow-${i}.bin`),
  }));
  const done: number[] = [];
  await downloadAll(jobs, { ...FAST, retries: 0, concurrency: 2, onFileDone: (i) => done.push(i) });
  assert.equal(maxActive, 2);
  assert.deepEqual([...done].sort(), [0, 1, 2, 3, 4, 5]);
});

test('downloadAll：一个文件失败就中止其余下载，返回时不再有在途请求', async () => {
  const jobs = [
    { url: `${base}/slow`, dest: path.join(dir, 'abort-0.bin') },
    { url: `${base}/gone`, dest: path.join(dir, 'abort-1.bin') },
    { url: `${base}/slow`, dest: path.join(dir, 'abort-2.bin') },
    { url: `${base}/slow`, dest: path.join(dir, 'abort-3.bin') },
  ];
  await assert.rejects(downloadAll(jobs, { ...FAST, retries: 0, concurrency: 3 }), /HTTP 404/);
  // 第 4 个从未开始，其余被中止的不应留下文件；等服务端原本的响应时间过去后也不应再冒出来
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const job of jobs) assert.equal(exists(job.dest), false, job.dest);
});

test('SSRF：内网 IP 字面量直接拒绝，不发请求也不重试', async () => {
  const dest = path.join(dir, 'ssrf-literal.bin');
  const before = hits.get('/ok') ?? 0;
  await withPrivateBlocked(() =>
    assert.rejects(downloadFile(`${base}/ok`, dest, { ...FAST, retries: 3 }), (err: Error) => {
      assert.match(err.message, /不允许访问内网或保留地址: 127\.0\.0\.1/);
      assert.doesNotMatch(err.message, /已重试/);
      return true;
    }),
  );
  assert.equal(hits.get('/ok') ?? 0, before);
  assert.equal(exists(dest), false);
});

test('SSRF：localhost 解析到回环地址，拒绝', async () => {
  const dest = path.join(dir, 'ssrf-localhost.bin');
  const before = hits.get('/ok') ?? 0;
  await withPrivateBlocked(() =>
    assert.rejects(
      downloadFile(`http://localhost:${port}/ok`, dest, { ...FAST, retries: 2 }),
      /不允许访问内网或保留地址: localhost（解析到 /,
    ),
  );
  assert.equal(hits.get('/ok') ?? 0, before);
});

test('SSRF：IPv4 映射的 IPv6 字面量（::ffff:127.0.0.1）拒绝', async () => {
  const dest = path.join(dir, 'ssrf-mapped.bin');
  await withPrivateBlocked(() =>
    assert.rejects(
      downloadFile(`http://[::ffff:127.0.0.1]:${port}/ok`, dest, { ...FAST, retries: 0 }),
      /不允许访问内网或保留地址/,
    ),
  );
});

test('SSRF：重定向到内网地址被拦下，内网目标从未被访问', async () => {
  const dest = path.join(dir, 'ssrf-redirect.bin');
  try {
    await assert.rejects(
      downloadFile(`${base}/redirect-private`, dest, { ...FAST, retries: 2 }),
      /不允许访问内网或保留地址: 127\.0\.0\.1/,
    );
  } finally {
    config.allowPrivateUrls = true;
  }
  assert.equal(hits.get('/redirect-private'), 1, '拦截不应重试');
  assert.equal(hits.get('/private-target'), undefined);
  assert.equal(exists(dest), false);
});

test('SSRF：重定向到云元数据地址被拦下，不发起连接', async () => {
  const dest = path.join(dir, 'ssrf-metadata.bin');
  const started = Date.now();
  try {
    await assert.rejects(
      downloadFile(`${base}/redirect-metadata`, dest, { ...FAST, retries: 0 }),
      /不允许访问内网或保留地址: 169\.254\.169\.254/,
    );
  } finally {
    config.allowPrivateUrls = true;
  }
  assert.ok(Date.now() - started < 2000, '不应等到连接超时');
});

test('SSRF：重定向到非 http 协议拒绝', async () => {
  const dest = path.join(dir, 'ssrf-file.bin');
  await assert.rejects(
    downloadFile(`${base}/redirect-file`, dest, { ...FAST, retries: 2 }),
    /只支持 http 或 https 链接，收到 file/,
  );
  assert.equal(hits.get('/redirect-file'), 1);
});

test('SSRF：URL 带用户名密码一律拒绝（即使允许内网）', async () => {
  const dest = path.join(dir, 'ssrf-cred.bin');
  await assert.rejects(
    downloadFile(`http://user:pass@127.0.0.1:${port}/ok`, dest, { ...FAST, retries: 2 }),
    /链接不能包含用户名或密码: 127\.0\.0\.1/,
  );
});

test('SSRF：ALLOW_PRIVATE_URLS=true 时放行 localhost', async () => {
  const dest = path.join(dir, 'allow-localhost.bin');
  const bytes = await downloadFile(`http://localhost:${port}/ok`, dest, { ...FAST, retries: 0 });
  assert.equal(bytes, BODY.length);
});

test('重定向：恰好 5 次可以下载，第 6 次报错且不重试', async () => {
  const ok = path.join(dir, 'hop-5.bin');
  await downloadFile(`${base}/hop/5`, ok, { ...FAST, retries: 0 });
  assert.equal(fs.statSync(ok).size, BODY.length);

  const tooMany = path.join(dir, 'hop-6.bin');
  await assert.rejects(
    downloadFile(`${base}/hop/6`, tooMany, { ...FAST, retries: 3 }),
    /重定向超过 5 次/,
  );
  assert.equal(hits.get('/hop/6'), 1);
  assert.equal(hits.get('/hop/0'), 1, '只有 hop/5 那次走到了终点');
  assert.equal(exists(tooMany), false);
});
