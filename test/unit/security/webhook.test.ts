import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { version } from '../../../package.json';
import { config } from '../../../src/config';
import {
  WEBHOOK_HEADERS,
  deliverWebhook,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../../src/services/webhook.service';

interface Received {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const original = {
  allowPrivateUrls: config.allowPrivateUrls,
  webhookSecret: config.webhookSecret,
  webhookRetries: config.webhookRetries,
  webhookTimeoutMs: config.webhookTimeoutMs,
};
const FAST = { retryBaseDelayMs: 10 };
const received = new Map<string, Received[]>();
let server: http.Server;
let base = '';

function record(pathname: string, entry: Received): number {
  const list = received.get(pathname) ?? [];
  list.push(entry);
  received.set(pathname, list);
  return list.length;
}

before(async () => {
  // 测试服务器在 127.0.0.1 上，需要放行内网；验证拦截的用例里再临时关掉
  config.allowPrivateUrls = true;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      const n = record(pathname, {
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const reply = (status: number, headers: Record<string, string> = {}) => {
        res.writeHead(status, headers);
        res.end('{}');
      };
      switch (pathname) {
        case '/ok':
        case '/signed':
        case '/unsigned':
          return reply(200);
        case '/created':
          return reply(201);
        case '/flaky':
          return n <= 2 ? reply(503) : reply(200);
        case '/drop-once':
        case '/drop-once-signed':
          return n === 1 ? req.socket.destroy() : reply(204);
        case '/rate-limited':
          return n === 1 ? reply(429, { 'retry-after': '1' }) : reply(200);
        case '/always-500':
          return reply(500);
        case '/bad-request':
          return reply(400);
        case '/gone':
          return reply(410);
        case '/redirect':
          return reply(302, { location: '/ok' });
        case '/hang':
          return; // 永不响应
        default:
          return reply(404);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  Object.assign(config, original);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  config.allowPrivateUrls = true;
  config.webhookSecret = '';
  config.webhookRetries = 3;
  config.webhookTimeoutMs = 5000;
});

const hits = (pathname: string) => received.get(pathname) ?? [];
const header = (entry: Received, name: string) => {
  const value = entry.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

test('成功投递：POST JSON，带事件、投递 ID、时间戳、User-Agent', async () => {
  config.webhookSecret = '';
  const payload = { taskId: 't1', status: 'completed', files: ['a.mp4'], n: 1.5, zh: '完成' };
  const result = await deliverWebhook(`${base}/ok`, payload, { event: 'task.completed', ...FAST });
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 200);
  assert.equal(result.error, undefined);

  const [req] = hits('/ok');
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body.toString('utf8')), payload);
  assert.equal(header(req, 'content-type'), 'application/json');
  assert.equal(header(req, 'user-agent'), `ffmpeg-service/${version}`);
  assert.equal(header(req, WEBHOOK_HEADERS.event), 'task.completed');
  assert.match(header(req, WEBHOOK_HEADERS.delivery) ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(header(req, WEBHOOK_HEADERS.delivery), result.deliveryId);
  assert.equal(header(req, WEBHOOK_HEADERS.attempt), '1');
  const ts = Number(header(req, WEBHOOK_HEADERS.timestamp));
  assert.ok(Math.abs(ts - Date.now() / 1000) < 5);
  assert.equal(header(req, WEBHOOK_HEADERS.signature), undefined, '没配密钥时不带签名');
});

test('2xx 都算成功（201）', async () => {
  const result = await deliverWebhook(`${base}/created`, {}, { event: 'task.completed' });
  assert.equal(result.delivered, true);
  assert.equal(result.status, 201);
});

test('5xx 重试后成功，投递 ID 不变、尝试序号递增', async () => {
  const retries: number[] = [];
  const result = await deliverWebhook(
    `${base}/flaky`,
    { a: 1 },
    { event: 'task.failed', ...FAST, onRetry: ({ attempt }) => retries.push(attempt) },
  );
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(retries, [2, 3]);
  const list = hits('/flaky');
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((r) => header(r, WEBHOOK_HEADERS.delivery))).size, 1);
  assert.deepEqual(
    list.map((r) => header(r, WEBHOOK_HEADERS.attempt)),
    ['1', '2', '3'],
  );
});

test('网络错误（连接被掐断）会重试', async () => {
  const result = await deliverWebhook(
    `${base}/drop-once`,
    {},
    { event: 'task.completed', ...FAST },
  );
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.status, 204);
});

test('429 会重试并遵守 Retry-After', async () => {
  const delays: number[] = [];
  const started = Date.now();
  const result = await deliverWebhook(
    `${base}/rate-limited`,
    {},
    { event: 'task.completed', ...FAST, onRetry: ({ delayMs }) => delays.push(delayMs) },
  );
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
  assert.ok(delays[0] >= 1000, `delay ${delays[0]}`);
  assert.ok(Date.now() - started >= 950);
});

test('重试用尽：返回最后的状态码，次数 = 重试数 + 1', async () => {
  config.webhookRetries = 2;
  const result = await deliverWebhook(
    `${base}/always-500`,
    {},
    { event: 'task.completed', ...FAST },
  );
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.status, 500);
  assert.equal(result.error, 'HTTP 500');
  assert.equal(hits('/always-500').length, 3);
});

test('4xx（400 / 410）不重试', async () => {
  for (const pathname of ['/bad-request', '/gone']) {
    const result = await deliverWebhook(
      `${base}${pathname}`,
      {},
      { event: 'task.completed', ...FAST },
    );
    assert.equal(result.delivered, false, pathname);
    assert.equal(result.attempts, 1, pathname);
    assert.match(result.error ?? '', /^HTTP 4\d\d$/);
    assert.equal(hits(pathname).length, 1, pathname);
  }
});

test('3xx 算失败，不跟随也不重试', async () => {
  const okBefore = hits('/ok').length;
  const result = await deliverWebhook(`${base}/redirect`, {}, { event: 'task.completed', ...FAST });
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 302);
  assert.match(result.error ?? '', /HTTP 302，回调地址不允许重定向/);
  assert.equal(hits('/ok').length, okBefore, '不应跟随到 /ok');
});

test('超时：单次请求超过 timeout 视为失败并重试', async () => {
  const started = Date.now();
  const result = await deliverWebhook(
    `${base}/hang`,
    {},
    { event: 'task.completed', ...FAST, retries: 1, timeoutMs: 200 },
  );
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 2);
  assert.match(result.error ?? '', /超过 0\.2 秒没有响应/);
  assert.ok(Date.now() - started < 3000);
});

test('超时默认取 config.webhookTimeoutMs', async () => {
  config.webhookTimeoutMs = 150;
  const result = await deliverWebhook(`${base}/hang`, {}, { event: 'task.completed', retries: 0 });
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 1);
  assert.match(result.error ?? '', /没有响应/);
});

test('signal 取消：请求进行中立即返回，不再重试', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const before = hits('/hang').length;
  const result = await deliverWebhook(
    `${base}/hang`,
    {},
    { event: 'task.completed', signal: controller.signal, ...FAST, timeoutMs: 10_000 },
  );
  assert.equal(result.delivered, false);
  assert.equal(result.error, '回调已取消');
  assert.equal(result.attempts, 1);
  assert.ok(Date.now() - started < 2000);
  // 等一会儿确认没有后续重试
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hits('/hang').length, before + 1);
});

test('signal 取消：退避等待中取消也立即返回', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 150);
  const result = await deliverWebhook(
    `${base}/always-500`,
    {},
    { event: 'task.completed', signal: controller.signal, retryBaseDelayMs: 10_000 },
  );
  assert.equal(result.delivered, false);
  assert.equal(result.error, '回调已取消');
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 500);
  assert.ok(Date.now() - started < 2000);
});

test('signal 已取消：一次都不发', async () => {
  const controller = new AbortController();
  controller.abort();
  const before = hits('/ok').length;
  const result = await deliverWebhook(`${base}/ok`, {}, { event: 'x', signal: controller.signal });
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 0);
  assert.equal(hits('/ok').length, before);
});

test('SSRF：回调地址是内网时拒绝且不重试、不发请求', async () => {
  config.allowPrivateUrls = false;
  const before = hits('/ok').length;
  const result = await deliverWebhook(`${base}/ok`, {}, { event: 'task.completed', ...FAST });
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 1);
  assert.match(result.error ?? '', /不允许访问内网或保留地址: 127\.0\.0\.1/);
  assert.equal(hits('/ok').length, before);
});

test('非 http(s) 回调地址拒绝', async () => {
  const result = await deliverWebhook('ftp://example.com/hook', {}, { event: 'task.completed' });
  assert.equal(result.delivered, false);
  assert.match(result.error ?? '', /只支持 http 或 https/);
});

test('payload 无法序列化时不发请求，返回错误', async () => {
  const result = await deliverWebhook(`${base}/ok`, { n: 1n }, { event: 'task.completed' });
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 0);
  assert.match(result.error ?? '', /无法序列化为 JSON/);
});

test('签名：配置 WEBHOOK_SECRET 后带 sha256 签名，接收方可校验', async () => {
  const secret = 'whsec_test_0123456789';
  config.webhookSecret = secret;
  const payload = { taskId: 'abc', text: '中文 & "quotes"' };
  const result = await deliverWebhook(`${base}/signed`, payload, { event: 'task.completed' });
  assert.equal(result.delivered, true);
  const [req] = hits('/signed');
  const ts = header(req, WEBHOOK_HEADERS.timestamp) ?? '';
  const signature = header(req, WEBHOOK_HEADERS.signature) ?? '';
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(signature, signWebhookPayload(secret, ts, req.body));

  // IncomingHttpHeaders 和 Headers 对象都支持
  assert.equal(verifyWebhookSignature(req.body, req.headers, secret), true);
  assert.equal(verifyWebhookSignature(req.body.toString('utf8'), req.headers, secret), true);
  const fetchHeaders = new Headers();
  fetchHeaders.set(WEBHOOK_HEADERS.timestamp, ts);
  fetchHeaders.set(WEBHOOK_HEADERS.signature, signature);
  assert.equal(verifyWebhookSignature(req.body, fetchHeaders, secret), true);
  // 大小写不同的普通对象也能找到头
  assert.equal(
    verifyWebhookSignature(
      req.body,
      { 'X-FFmpeg-Service-Timestamp': ts, 'X-FFMPEG-SERVICE-SIGNATURE': signature },
      secret,
    ),
    true,
  );

  // 篡改内容、错误密钥、缺头都失败
  const tampered = Buffer.from(req.body.toString('utf8').replace('abc', 'abd'));
  assert.equal(verifyWebhookSignature(tampered, req.headers, secret), false);
  assert.equal(verifyWebhookSignature(req.body, req.headers, 'wrong-secret'), false);
  assert.equal(verifyWebhookSignature(req.body, req.headers, ''), false);
  assert.equal(
    verifyWebhookSignature(req.body, { [WEBHOOK_HEADERS.timestamp]: ts }, secret),
    false,
  );
  // 重新序列化的 JSON（空格不同）签名不匹配，必须用原始字节
  assert.equal(
    verifyWebhookSignature(JSON.stringify(payload, null, 2), req.headers, secret),
    false,
  );
});

test('签名：时间戳超出容忍期视为重放；多个签名（轮换密钥）任一匹配即可', () => {
  const secret = 'whsec_rotate';
  const body = '{"a":1}';
  const old = Math.floor(Date.now() / 1000) - 1000;
  const oldHeaders = {
    [WEBHOOK_HEADERS.timestamp]: String(old),
    [WEBHOOK_HEADERS.signature]: signWebhookPayload(secret, old, body),
  };
  assert.equal(verifyWebhookSignature(body, oldHeaders, secret), false);
  assert.equal(verifyWebhookSignature(body, oldHeaders, secret, 2000), true);

  const now = Math.floor(Date.now() / 1000);
  const rotated = {
    [WEBHOOK_HEADERS.timestamp]: String(now),
    [WEBHOOK_HEADERS.signature]: `${signWebhookPayload('old-secret', now, body)}, ${signWebhookPayload(secret, now, body)}`,
  };
  assert.equal(verifyWebhookSignature(body, rotated, secret), true);
  assert.equal(verifyWebhookSignature(body, rotated, 'old-secret'), true);
  assert.equal(verifyWebhookSignature(body, rotated, 'other'), false);

  const badTs = { ...rotated, [WEBHOOK_HEADERS.timestamp]: '12abc' };
  assert.equal(verifyWebhookSignature(body, badTs, secret), false);
});

test('签名：每次重试重新签名，时间戳和签名都匹配各自请求', async () => {
  const secret = 'whsec_retry';
  config.webhookSecret = secret;
  const result = await deliverWebhook(
    `${base}/drop-once-signed`,
    { r: 1 },
    { event: 'e', ...FAST },
  );
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
  const last = hits('/drop-once-signed').at(-1)!;
  assert.equal(verifyWebhookSignature(last.body, last.headers, secret), true);
});
