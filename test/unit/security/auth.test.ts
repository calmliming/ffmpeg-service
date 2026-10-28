import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { config } from '../../../src/config';
import {
  extractApiKeys,
  isValidApiKey,
  redactApiKey,
  requireApiKey,
  requireApiKeyForFiles,
} from '../../../src/middleware/auth';

const original = { apiKeys: config.apiKeys, protectFiles: config.protectFiles };
const KEYS = ['sk-first-0123456789', 'sk-second-abcdefghij'];
let server: http.Server;
let base = '';
let reached = 0;

before(async () => {
  const app = express();
  app.get('/protected', requireApiKey, (_req, res) => {
    reached++;
    res.json({ success: true });
  });
  app.options('/protected', requireApiKey, (_req, res) => {
    res.sendStatus(204);
  });
  app.get('/files/a.mp4', requireApiKeyForFiles, (_req, res) => {
    res.send('file');
  });
  app.get('/echo-keys', (req, res) => {
    res.json(extractApiKeys(req));
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  config.apiKeys = original.apiKeys;
  config.protectFiles = original.protectFiles;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  config.apiKeys = [...KEYS];
  config.protectFiles = false;
});

async function get(pathname: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${pathname}`, { headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function assertUnauthorized(pathname: string, headers: Record<string, string> = {}) {
  const before = reached;
  const res = await get(pathname, headers);
  assert.equal(res.status, 401, `${pathname} ${JSON.stringify(headers)}`);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(res.text), { success: false, error: '缺少或无效的 API Key' });
  assert.equal(reached, before, '不应进入路由');
}

test('未配置 API_KEYS 时所有请求放行', async () => {
  config.apiKeys = [];
  const res = await get('/protected');
  assert.equal(res.status, 200);
});

test('配置了 Key 但请求没带：401 + WWW-Authenticate: Bearer + 中文错误', async () => {
  config.apiKeys = [...KEYS];
  await assertUnauthorized('/protected');
});

test('Authorization: Bearer 通过，scheme 不区分大小写', async () => {
  config.apiKeys = [...KEYS];
  assert.equal((await get('/protected', { authorization: `Bearer ${KEYS[0]}` })).status, 200);
  assert.equal((await get('/protected', { authorization: `bearer ${KEYS[1]}` })).status, 200);
});

test('X-API-Key 请求头通过', async () => {
  config.apiKeys = [...KEYS];
  assert.equal((await get('/protected', { 'x-api-key': KEYS[1] })).status, 200);
});

test('查询参数 api_key 通过（给 EventSource 用）', async () => {
  config.apiKeys = [...KEYS];
  const res = await get(`/protected?api_key=${encodeURIComponent(KEYS[0])}`);
  assert.equal(res.status, 200);
});

test('错误的 Key、Key 的前缀、多出字符、非 Bearer scheme 都拒绝', async () => {
  config.apiKeys = [...KEYS];
  await assertUnauthorized('/protected', { authorization: 'Bearer wrong' });
  await assertUnauthorized('/protected', { authorization: `Bearer ${KEYS[0].slice(0, -1)}` });
  await assertUnauthorized('/protected', { authorization: `Bearer ${KEYS[0]}x` });
  await assertUnauthorized('/protected', { authorization: `Basic ${KEYS[0]}` });
  await assertUnauthorized('/protected', { authorization: KEYS[0] });
  await assertUnauthorized('/protected', { 'x-api-key': '' });
  await assertUnauthorized(`/protected?api_key=${KEYS[0]}&api_key=${KEYS[1]}`);
});

test('多种方式同时出现时任一有效即通过', async () => {
  config.apiKeys = [...KEYS];
  const res = await get('/protected', { authorization: 'Bearer stale', 'x-api-key': KEYS[0] });
  assert.equal(res.status, 200);
});

test('OPTIONS 预检不需要 Key', async () => {
  config.apiKeys = [...KEYS];
  const res = await fetch(`${base}/protected`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
});

test('requireApiKeyForFiles：PROTECT_FILES=false 时不校验，true 时校验', async () => {
  config.apiKeys = [...KEYS];
  config.protectFiles = false;
  assert.equal((await get('/files/a.mp4')).status, 200);
  config.protectFiles = true;
  assert.equal((await get('/files/a.mp4')).status, 401);
  assert.equal((await get(`/files/a.mp4?api_key=${KEYS[1]}`)).status, 200);
});

test('extractApiKeys：按 Bearer、X-API-Key、api_key 的顺序收集', async () => {
  const res = await get('/echo-keys?api_key=q', { authorization: 'Bearer b', 'x-api-key': ' h ' });
  assert.deepEqual(JSON.parse(res.text), ['b', 'h', 'q']);
});

test('isValidApiKey：逐个比较所有配置的 Key', () => {
  config.apiKeys = [...KEYS];
  assert.equal(isValidApiKey(KEYS[0]), true);
  assert.equal(isValidApiKey(KEYS[1]), true);
  assert.equal(isValidApiKey(''), false);
  assert.equal(isValidApiKey(KEYS.join(',')), false);
  config.apiKeys = [];
  assert.equal(isValidApiKey(KEYS[0]), false);
});

test('redactApiKey：日志里隐藏 api_key 查询参数', () => {
  assert.equal(
    redactApiKey('/api/tasks/1/progress?api_key=sk-secret&x=1'),
    '/api/tasks/1/progress?api_key=***&x=1',
  );
  assert.equal(redactApiKey('/a?x=1&API_KEY=abc#frag'), '/a?x=1&API_KEY=***#frag');
  assert.equal(redactApiKey('/a?my_api_key=keep'), '/a?my_api_key=keep');
});
