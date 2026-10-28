import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../../src/config';
import {
  errorHandler,
  HttpError,
  isRedisUnavailable,
  sendServerError,
} from '../../src/middleware/error';
import { formatIssues } from '../../src/middleware/validate';
import { thumbSizeParam } from '../../src/operations/visual/shared';

function fakeRes() {
  const sent: { status?: number; body?: { success: boolean; error: string } } = {};
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: { success: boolean; error: string }) {
      sent.body = body;
      return this;
    },
  };
  return { res, sent };
}

function handle(err: Error) {
  const { res, sent } = fakeRes();
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    errorHandler(err, {} as never, res as never, () => {});
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return sent;
}

test('errorHandler：busboy 的畸形 multipart 错误返回 400 而不是 500', () => {
  const sent = handle(new Error('Unexpected end of form'));
  assert.equal(sent.status, 400);
  assert.match(sent.body!.error, /上传请求格式错误/);
  assert.equal(handle(new Error('Multipart: Boundary not found')).status, 400);
});

test('errorHandler：不支持或畸形的 multipart Content-Type 返回 400', () => {
  assert.equal(
    handle(new Error('Unsupported content type: multipart/related; boundary=abc')).status,
    400,
  );
  assert.equal(handle(new Error('Malformed content type')).status, 400);
});

test('errorHandler：JSON 请求体过大返回中文 413', () => {
  const err = Object.assign(new Error('request entity too large'), {
    type: 'entity.too.large',
    status: 413,
  });
  const sent = handle(err);
  assert.equal(sent.status, 413);
  assert.match(sent.body!.error, /100 KB/);
});

test('errorHandler：响应已提前发出时忽略迟到的错误，不再写响应也不交给 next', () => {
  const { res, sent } = fakeRes();
  const ended = Object.assign(res, { writableEnded: true, headersSent: true });
  let nextCalled = false;
  const warn = console.warn;
  console.warn = () => {};
  try {
    errorHandler(new Error('Unexpected end of form'), {} as never, ended as never, () => {
      nextCalled = true;
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(nextCalled, false);
  assert.equal(sent.status, undefined);
});

test('errorHandler：客户端中断上传返回 499', () => {
  assert.equal(handle(new Error('Request aborted')).status, 499);
  // 连接断开时 multer 也可能先报 Request closed
  assert.equal(handle(new Error('Request closed')).status, 499);
});

test('errorHandler：客户端已断开（响应已销毁）时不再写响应', () => {
  const { res, sent } = fakeRes();
  const warn = console.warn;
  console.warn = () => {};
  try {
    errorHandler(
      new Error('Request aborted'),
      {} as never,
      Object.assign(res, { destroyed: true }) as never,
      () => {},
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(sent.status, undefined);
});

test('errorHandler / sendServerError：返回给客户端的错误信息去掉服务器目录，接口路径保留', () => {
  const file = path.join(config.uploadDir, '0b1c.mp4');
  const raw = `无法解析文件，可能不是有效的媒体文件: ${file}: Invalid data（异步处理请用 /api/process/gif）`;
  const expected =
    '无法解析文件，可能不是有效的媒体文件: 0b1c.mp4: Invalid data（异步处理请用 /api/process/gif）';
  assert.equal(handle(new Error(raw)).body!.error, expected);
  assert.equal(
    handle(new Error('EACCES: open /srv/app/output/x/y.mp4')).body!.error,
    'EACCES: open y.mp4',
  );
  // 引擎自己的 400 里提到的接口路径不受影响
  assert.equal(
    handle(new HttpError(400, '第 1 步缺少 op（操作名，见 GET /api/operations）')).body!.error,
    '第 1 步缺少 op（操作名，见 GET /api/operations）',
  );

  const error = console.error;
  console.error = () => {};
  try {
    const other = fakeRes();
    sendServerError(other.res as never, new Error(raw));
    assert.equal(other.sent.body!.error, expected);
  } finally {
    console.error = error;
  }
});

test('formatIssues：同一参数的几个部分报了一模一样的信息时只留一条', () => {
  const schema = z.object({ size: thumbSizeParam('size') });
  const parsed = schema.safeParse({ size: '10x10' });
  assert.equal(parsed.success, false);
  // 宽和高各报一条相同的信息
  assert.ok(parsed.error!.issues.length >= 2);
  const message = formatIssues(parsed.error!.issues);
  assert.match(message, /^size 必须是 宽x高/);
  assert.equal(message.split('size 必须是').length - 1, 1, message);

  // 不同的信息都保留
  const two = z
    .object({ a: z.number({ error: 'a 必须是数字' }), b: z.number({ error: 'b 必须是数字' }) })
    .safeParse({});
  assert.equal(formatIssues(two.error!.issues), 'a 必须是数字, b 必须是数字');
});

test('errorHandler：文件超过上限返回 413，其他 multer 错误返回 400', () => {
  assert.equal(handle(new multer.MulterError('LIMIT_FILE_SIZE')).status, 413);
  assert.equal(handle(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'video')).status, 400);
});

test('errorHandler：HttpError 按自带状态码返回，未知错误返回 500', () => {
  assert.equal(handle(new HttpError(400, '不支持的文件类型')).status, 400);
  assert.equal(handle(new Error('boom')).status, 500);
});

test('errorHandler：引擎主动抛出的 HttpError（队列满 429、同步超时 504）原样返回状态码和中文信息', () => {
  const full = handle(new HttpError(429, '任务队列已满，请稍后重试'));
  assert.deepEqual(full, {
    status: 429,
    body: { success: false, error: '任务队列已满，请稍后重试' },
  });
  assert.equal(handle(new HttpError(504, '处理超时')).status, 504);
});

test('errorHandler：multer 2 新增的限制和表单参数过多都有中文提示', () => {
  const nesting = handle(new multer.MulterError('LIMIT_FIELD_NESTING' as never, 'a[b][c]'));
  assert.equal(nesting.status, 400);
  assert.match(nesting.body!.error, /a\[b\]\[c\] 嵌套过深/);
  const fields = handle(new multer.MulterError('LIMIT_FIELD_COUNT'));
  assert.equal(fields.body!.error, '上传参数错误: 表单字段数量超过上限');
  const params = Object.assign(new Error('too many parameters'), {
    type: 'parameters.too.many',
    status: 413,
  });
  assert.equal(handle(params).status, 413);
  const badJson = Object.assign(new Error('Unexpected token'), {
    type: 'entity.parse.failed',
    status: 400,
  });
  assert.equal(handle(badJson).body!.error, '请求体不是合法的 JSON');
});

test('isRedisUnavailable：识别 ioredis 断线、超时和连接被拒', () => {
  assert.equal(isRedisUnavailable(new Error('Connection is closed.')), true);
  assert.equal(isRedisUnavailable(new Error('Command timed out')), true);
  assert.equal(isRedisUnavailable(new Error('connect ECONNREFUSED 127.0.0.1:6379')), true);
  assert.equal(isRedisUnavailable(new Error('ffmpeg exited with code 1')), false);
  assert.equal(isRedisUnavailable('Connection is closed.'), false);
});

test('sendServerError：HttpError 按自带状态码返回，响应已发出时什么都不做', () => {
  const http = fakeRes();
  sendServerError(http.res as never, new HttpError(400, '链接不可用'));
  assert.equal(http.sent.status, 400);
  assert.equal(http.sent.body!.error, '链接不可用');

  const sent = fakeRes();
  sent.res.headersSent = true;
  sendServerError(sent.res as never, new Error('late'));
  assert.equal(sent.sent.status, undefined);
});

test('sendServerError：Redis 不可用返回 503，其他错误返回 500', () => {
  const error = console.error;
  console.error = () => {};
  try {
    const down = fakeRes();
    const err = new Error('Reached the max retries per request limit (which is 2).');
    sendServerError(down.res as never, err);
    assert.equal(down.sent.status, 503);

    const other = fakeRes();
    sendServerError(other.res as never, new Error('ffprobe exited with code 1'));
    assert.equal(other.sent.status, 500);
  } finally {
    console.error = error;
  }
});
