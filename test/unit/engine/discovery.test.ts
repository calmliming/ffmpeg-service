import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  cleanupRoot,
  getJson,
  postJson,
  redisAvailable,
  startEngine,
  startFileServer,
  type Engine,
} from './harness';
import { allOps } from './fake-ops';
import { ffmpegSkip } from '../../helpers/media';
import { createApp, type AppOptions } from '../../../src/app';
import { config } from '../../../src/config';
import type { OperationInfo } from '../../../src/core/catalog';
import { urlFieldsOf } from '../../../src/core/inputs';
import { operations as registry } from '../../../src/operations';
import { TaskService } from '../../../src/services/task.service';

type Json = Record<string, unknown>;

let redisUp = false;
let files: Awaited<ReturnType<typeof startFileServer>>;
let catalogApp: { base: string; server: http.Server };

async function serve(options: AppOptions): Promise<{ base: string; server: http.Server }> {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// 目录和 OpenAPI 不碰 Redis：TaskService 第一次用到才连接，队列用空对象
const offline = (): AppOptions => ({
  operations: registry,
  tasks: new TaskService({ keyPrefix: 'unused:' }),
  queue: {} as never,
});

before(async () => {
  redisUp = await redisAvailable();
  files = await startFileServer({ '/a.mp4': Buffer.alloc(64) });
  catalogApp = await serve(offline());
});

after(async () => {
  await closeServer(catalogApp.server);
  await files.close();
  cleanupRoot();
});

test('GET /api/operations：注册表里每个操作都有说明、输入槽和带中文描述的参数 JSON Schema', async () => {
  const res = await getJson(`${catalogApp.base}/api/operations`);
  assert.equal(res.status, 200);
  const list = res.body.data as unknown as OperationInfo[];
  assert.equal(list.length, registry.length);
  assert.ok(list.length > 0);

  for (const op of list) {
    const where = op.name;
    assert.equal(op.method, 'POST', where);
    assert.match(op.route, /^\/api\//, where);
    assert.ok(op.title && op.description, where);
    assert.equal(typeof op.sync, 'boolean', where);
    assert.equal(typeof op.chainable, 'boolean', where);
    assert.deepEqual(Object.keys(op.pipeline).sort(), ['first', 'last', 'middle'], where);
    for (const slot of op.inputs) {
      assert.ok(slot.urlFields.length > 0, `${where}.${slot.name}`);
      assert.ok(slot.description, `${where}.${slot.name}`);
    }
    const params = op.params as Json;
    assert.equal(params.type, 'object', where);
    assert.equal(params.$schema, 'https://json-schema.org/draft/2020-12/schema', where);
    assert.equal('additionalProperties' in params, false, where);
    const properties = (params.properties ?? {}) as Record<string, Json>;
    for (const [key, schema] of Object.entries(properties)) {
      assert.equal(
        typeof schema.description,
        'string',
        `${where}.${key} 缺少 .meta({ description })`,
      );
      assert.ok((schema.description as string).length > 0, `${where}.${key}`);
    }
    // required 只列真正必填的：有默认值的字段不算
    for (const key of (params.required as string[] | undefined) ?? []) {
      assert.ok(key in properties, `${where}.${key}`);
      assert.equal('default' in properties[key], false, `${where}.${key} 有默认值却被列为必填`);
    }
  }

  const byName = new Map(list.map((op) => [op.name, op]));
  // preprocess 包装的 coerce 工具：按转换后的类型输出，默认值、范围和描述都保留
  const transcode = byName.get('transcode');
  if (transcode) {
    const props = (transcode.params as { properties: Record<string, Json> }).properties;
    assert.equal(props.format.default, 'mp4');
    assert.equal(props.fps.type, 'number');
    assert.equal(props.fps.maximum, 120);
    assert.equal(
      ((transcode.params as Json).required as string[] | undefined) ?? undefined,
      undefined,
    );
    assert.deepEqual(transcode.pipeline, { first: true, middle: true, last: true });
  }
  const trim = byName.get('trim');
  if (trim) assert.deepEqual((trim.params as Json).required, ['startTime']);
  const hls = byName.get('video.hls');
  if (hls) assert.deepEqual(hls.pipeline, { first: true, middle: false, last: true });
  const info = byName.get('info');
  if (info) assert.deepEqual(info.pipeline, { first: false, middle: false, last: false });

  // 带点的操作名也能直接查
  const dotted = list.find((op) => op.name.includes('.'));
  if (dotted) {
    const one = await getJson(`${catalogApp.base}/api/operations/${dotted.name}`);
    assert.equal(one.status, 200);
    assert.equal((one.body.data as unknown as OperationInfo).route, dotted.route);
  }
  const missing = await getJson(`${catalogApp.base}/api/operations/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, '操作不存在: nope');
});

/** 按 JSON Pointer 解析文档内的 $ref */
function resolvePointer(doc: Json, ref: string): unknown {
  assert.ok(ref.startsWith('#/'), ref);
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((node, key) => (node as Json | undefined)?.[key], doc);
}

function walk(value: unknown, visit: (node: Json, path: string) => void, path = '#'): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, visit, `${path}/${i}`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visit(value as Json, path);
  for (const [key, inner] of Object.entries(value as Json)) walk(inner, visit, `${path}/${key}`);
}

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

test('GET /api/openapi.json：OpenAPI 3.1，每个操作一条 POST（multipart 和 JSON 两种请求体），引用都能解析', async () => {
  const res = await fetch(`${catalogApp.base}/api/openapi.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const text = await res.text();
  assert.ok(text.length < 3 * 1024 * 1024, `文档 ${text.length} 字节`);
  const doc = JSON.parse(text) as Json;
  assert.equal(doc.openapi, '3.1.0');
  const info = doc.info as Json;
  assert.equal(info.title, 'FFmpeg Service API');
  assert.match(String(info.version), /^\d+\.\d+\.\d+/);
  assert.equal('security' in doc, false, '没配 API_KEYS 时不声明安全要求');
  assert.equal('securitySchemes' in (doc.components as Json), false);

  const paths = doc.paths as Record<string, Record<string, Json>>;
  for (const op of registry) {
    const post = paths[op.route]?.post;
    assert.ok(post, `缺少 ${op.route}`);
    assert.equal(post.operationId, op.name);
    const content = (post.requestBody as Json).content as Record<string, { schema: Json }>;
    const multipart = content['multipart/form-data'].schema.properties as Record<string, Json>;
    const body = content['application/json'].schema.properties as Record<string, Json>;
    for (const slot of op.inputs) {
      const file = multipart[slot.name];
      assert.ok(file, `${op.name} 的 multipart 缺少文件字段 ${slot.name}`);
      assert.ok(file.format === 'binary' || (file.items as Json)?.format === 'binary', op.name);
      // JSON 请求体没有上传字段，只有链接字段（compose 的 videos 两者同名）
      const urlFields = urlFieldsOf(slot);
      if (slot.name in body) assert.ok(urlFields.includes(slot.name), `${op.name}.${slot.name}`);
      for (const field of urlFields) assert.ok(field in body, `${op.name} 缺少链接字段 ${field}`);
    }
    for (const key of Object.keys(op.params.shape)) {
      assert.ok(key in multipart && key in body, `${op.name}.${key}`);
    }
    assert.ok('callbackUrl' in body);
    const responses = post.responses as Record<string, Json>;
    const ok = (responses['200'].content as Record<string, { schema: Json }>)['application/json'];
    assert.equal(
      ok.schema.$ref,
      op.sync ? '#/components/schemas/SyncResponse' : '#/components/schemas/TaskAcceptedResponse',
    );
    assert.ok(responses['400'] && responses['500']);
    if (op.sync) assert.ok(responses['504']);
    else assert.ok(responses['429'] && responses['503']);
  }

  const platform: [string, string][] = [
    ['/api/health', 'get'],
    ['/api/operations', 'get'],
    ['/api/operations/{name}', 'get'],
    ['/api/openapi.json', 'get'],
    ['/api/pipeline', 'post'],
    ['/api/tasks/{id}', 'get'],
    ['/api/tasks/{id}', 'delete'],
    ['/api/tasks/{id}/cancel', 'post'],
    ['/api/tasks/{id}/progress', 'get'],
    ['/api/files/{name}', 'get'],
  ];
  for (const [route, method] of platform) assert.ok(paths[route]?.[method], `${method} ${route}`);
  assert.ok(
    (paths['/api/tasks/{id}/progress'].get.responses as Record<string, Json>)['200'].content,
  );
  assert.deepEqual(
    Object.keys((paths['/api/pipeline'].post.requestBody as Json).content as Json).sort(),
    ['application/json', 'multipart/form-data'],
  );

  // operationId 唯一；路径模板参数都有声明；每个响应都有 description
  const ids = new Set<string>();
  for (const [route, item] of Object.entries(paths)) {
    const templated = [...route.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const id = operation.operationId as string;
      assert.ok(id && !ids.has(id), `operationId 重复或缺失: ${method} ${route}`);
      ids.add(id);
      const declared = ((operation.parameters as Json[] | undefined) ?? [])
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      assert.deepEqual(declared.sort(), [...templated].sort(), `${method} ${route} 的路径参数`);
      for (const [code, response] of Object.entries(operation.responses as Record<string, Json>)) {
        const resolved = (
          response.$ref ? resolvePointer(doc, response.$ref as string) : response
        ) as Json;
        assert.ok(resolved?.description, `${method} ${route} ${code} 缺少 description`);
      }
    }
  }

  // 所有 $ref 都指向文档里存在的节点；嵌入的参数 schema 不带 $schema / $defs
  let refs = 0;
  walk(doc, (node, where) => {
    if (typeof node.$ref === 'string') {
      refs++;
      assert.ok(
        resolvePointer(doc, node.$ref) !== undefined,
        `${where} 的 $ref 无法解析: ${node.$ref}`,
      );
    }
    if (where.startsWith('#/paths')) {
      assert.equal('$schema' in node, false, where);
      assert.equal('$defs' in node, false, where);
    }
  });
  assert.ok(refs > registry.length);
});

test('OpenAPI：配置了 API_KEYS 时声明安全方案，健康检查和（默认的）下载不要求 Key，文档本身要 Key', async () => {
  config.apiKeys = ['sk-openapi-test'];
  const app = await serve(offline());
  try {
    assert.equal((await fetch(`${app.base}/api/openapi.json`)).status, 401);
    const res = await fetch(`${app.base}/api/openapi.json`, {
      headers: { 'x-api-key': 'sk-openapi-test' },
    });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as Json;
    const schemes = (doc.components as Json).securitySchemes as Record<string, Json>;
    assert.deepEqual(Object.keys(schemes).sort(), ['apiKeyHeader', 'apiKeyQuery', 'bearerAuth']);
    assert.equal(schemes.bearerAuth.scheme, 'bearer');
    assert.equal(schemes.apiKeyHeader.name, 'X-API-Key');
    assert.equal(schemes.apiKeyQuery.name, 'api_key');
    assert.equal((doc.security as unknown[]).length, 3);
    const paths = doc.paths as Record<string, Record<string, Json>>;
    assert.deepEqual(paths['/api/health'].get.security, []);
    assert.deepEqual(paths['/api/files/{name}'].get.security, []);
    assert.ok((paths['/api/tasks/{id}'].get.responses as Json)['401']);
    assert.ok((paths[registry[0].route].post.responses as Json)['401']);

    config.protectFiles = true;
    const protectedDoc = (await (
      await fetch(`${app.base}/api/openapi.json`, { headers: { 'x-api-key': 'sk-openapi-test' } })
    ).json()) as Json;
    const download = (protectedDoc.paths as Record<string, Record<string, Json>>)[
      '/api/files/{name}'
    ].get;
    assert.equal('security' in download, false);
    assert.ok((download.responses as Json)['401']);
  } finally {
    config.apiKeys = [];
    config.protectFiles = false;
    await closeServer(app.server);
  }
});

test('健康检查：Redis 不可用时 503，queue 为 null，不去查队列', async () => {
  let counted = false;
  const app = await serve({
    operations: allOps,
    tasks: { ping: async () => false } as unknown as TaskService,
    queue: {
      getJobCounts: async () => {
        counted = true;
        return {};
      },
    } as never,
  });
  try {
    const res = await getJson(`${app.base}/api/health`);
    assert.equal(res.status, 503);
    assert.match(res.body.error!, /redis/);
    const data = res.body.data!;
    assert.equal(data.redis, 'unavailable');
    assert.equal(data.queue, null);
    assert.equal(data.operations, allOps.length);
    assert.deepEqual(data.auth, { enabled: false, protectFiles: false });
    assert.equal(counted, false);
  } finally {
    await closeServer(app.server);
  }
});

test(
  '健康检查：队列计数（排队含带优先级的）、存储、鉴权、操作数和版本',
  { skip: ffmpegSkip },
  async (t) => {
    if (!redisUp) {
      t.skip('Redis 不可用（localhost:6379）');
      return;
    }
    let idle: Engine | undefined;
    try {
      idle = await startEngine({ operations: allOps, worker: false });
      const submit = () => postJson(`${idle!.base}/api/test/copy`, { url: `${files.base}/a.mp4` });
      assert.equal((await submit()).status, 200);
      assert.equal((await submit()).status, 200);
      const res = await getJson(`${idle.base}/api/health`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = res.body.data!;
      assert.equal(data.service, 'ffmpeg-service');
      assert.match(String(data.version), /^\d+\.\d+\.\d+/);
      assert.equal(data.status, 'running');
      assert.equal(data.ffmpeg, 'available');
      assert.equal(data.redis, 'available');
      assert.equal(data.storage, 'local');
      assert.equal(data.operations, allOps.length);
      assert.deepEqual(data.queue, { waiting: 2, active: 0, delayed: 0, failed: 0 });
      assert.deepEqual(data.auth, { enabled: false, protectFiles: false });
      assert.ok(!Number.isNaN(Date.parse(String(data.timestamp))));
    } finally {
      await idle?.close();
    }
  },
);
