import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fetch } from 'undici';
import { config } from '../../../src/config';
import { HttpError } from '../../../src/middleware/error';
import { downloadFile } from '../../../src/utils/download';
import {
  UrlGuardError,
  assertPublicUrl,
  embeddedIPv4,
  findUrlGuardError,
  guardedLookup,
  isNonPublicAddress,
  publicDispatcher,
} from '../../../src/utils/url-guard';

const originalAllowPrivate = config.allowPrivateUrls;
let server: http.Server;
let port = 0;
let hits = 0;

before(async () => {
  config.allowPrivateUrls = false;
  server = http.createServer((_req, res) => {
    hits++;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  config.allowPrivateUrls = originalAllowPrivate;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function withPrivateAllowed<T>(fn: () => Promise<T>): Promise<T> {
  config.allowPrivateUrls = true;
  try {
    return await fn();
  } finally {
    config.allowPrivateUrls = false;
  }
}

const BLOCKED = [
  '0.0.0.0',
  '0.255.255.255',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.127.255.254',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.8',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '[::1]',
  '::127.0.0.1', // 已废弃的 IPv4 兼容地址
  'fc00::1',
  'fd12:3456:789a::1',
  'fe80::1',
  'fe80::1%eth0',
  'fec0::1',
  'ff02::1',
  '2001:db8::1',
  '3fff::1',
  '100::1',
  '64:ff9b:1::a00:1',
  '::ffff:0:7f00:1', // SIIT 转换地址
  '::ffff:0:8.8.8.8',
  // 内嵌 IPv4 的各种 IPv6 写法
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '64:ff9b::a9fe:a9fe',
  '64:ff9b::127.0.0.1',
  '2002:7f00:1::1',
  '2002:c0a8:101::1',
  '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo，客户端地址 192.0.2.45
  'not-an-ip',
  '',
];

const PUBLIC = [
  '8.8.8.8',
  '1.1.1.1',
  '100.63.255.255',
  '100.128.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '192.167.255.255',
  '192.169.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '[2606:4700:4700::1111]',
  '::ffff:8.8.8.8',
  '64:ff9b::808:808',
  '2002:808:808::1',
];

test('isNonPublicAddress：内网、保留和内嵌私有 IPv4 的地址都判为非公网', () => {
  for (const address of BLOCKED) assert.equal(isNonPublicAddress(address), true, address);
});

test('isNonPublicAddress：公网地址（含内嵌公网 IPv4）放行', () => {
  for (const address of PUBLIC) assert.equal(isNonPublicAddress(address), false, address);
});

test('embeddedIPv4：取出映射、NAT64、6to4、Teredo 里的 IPv4', () => {
  assert.equal(embeddedIPv4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(embeddedIPv4('::ffff:192.168.0.1'), '192.168.0.1');
  assert.equal(embeddedIPv4('64:ff9b::a9fe:a9fe'), '169.254.169.254');
  assert.equal(embeddedIPv4('2002:c0a8:101::1'), '192.168.1.1');
  assert.equal(embeddedIPv4('2001:0:4136:e378:8000:63bf:3fff:fdd2'), '192.0.2.45');
  assert.equal(embeddedIPv4('2606:4700:4700::1111'), undefined);
  assert.equal(embeddedIPv4('127.0.0.1'), undefined);
});

test('assertPublicUrl：公网 IP 字面量通过（不需要 DNS）', async () => {
  await assertPublicUrl('http://8.8.8.8/video.mp4');
  await assertPublicUrl('https://[2606:4700:4700::1111]:8443/a?b=c');
});

test('assertPublicUrl：内网地址的各种写法都拒绝，抛 400 并带主机名', async () => {
  const cases: [string, RegExp][] = [
    ['http://127.0.0.1/', /127\.0\.0\.1/],
    ['http://2130706433/', /127\.0\.0\.1/], // 十进制整数写法
    ['http://0x7f.1/', /127\.0\.0\.1/], // 十六进制简写
    ['http://0177.0.0.1/', /127\.0\.0\.1/], // 八进制
    ['http://169.254.169.254/latest/meta-data/', /169\.254\.169\.254/],
    ['http://[::1]:8080/', /::1/],
    ['http://[::ffff:127.0.0.1]/', /::ffff:7f00:1/],
    ['http://[fd00::1]/', /fd00::1/],
    ['http://localhost:9527/', /localhost（解析到 /],
    ['http://LOCALHOST/', /localhost/],
  ];
  for (const [url, host] of cases) {
    await assert.rejects(assertPublicUrl(url), (err: unknown) => {
      assert.ok(err instanceof UrlGuardError, url);
      assert.ok(err instanceof HttpError, url);
      assert.equal(err.status, 400);
      assert.equal(err.retryable, false);
      assert.match(err.message, /不允许访问内网或保留地址/, url);
      assert.match(err.message, host, url);
      assert.match(err.message, /ALLOW_PRIVATE_URLS=true/);
      return true;
    });
  }
});

test('assertPublicUrl：非 http(s)、格式错误、带用户名密码都拒绝', async () => {
  await assert.rejects(
    assertPublicUrl('ftp://example.com/a.mp4'),
    /只支持 http 或 https 链接，收到 ftp/,
  );
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /只支持 http 或 https/);
  await assert.rejects(assertPublicUrl('javascript:alert(1)'), /只支持 http 或 https/);
  await assert.rejects(assertPublicUrl('not a url'), /链接格式不正确: not a url/);
  await assert.rejects(
    assertPublicUrl('https://user:secret@example.com/a.mp4'),
    /链接不能包含用户名或密码: example\.com/,
  );
  await assert.rejects(assertPublicUrl('https://user@example.com/'), /用户名或密码/);
  // 允许内网时也不接受带凭据的链接
  await withPrivateAllowed(() =>
    assert.rejects(assertPublicUrl('http://a:b@127.0.0.1/'), /用户名或密码/),
  );
});

test('assertPublicUrl：ALLOW_PRIVATE_URLS=true 时放行内网地址', async () => {
  await withPrivateAllowed(async () => {
    await assertPublicUrl('http://127.0.0.1:9527/');
    await assertPublicUrl('http://localhost/');
    await assertPublicUrl('http://[::1]/');
  });
});

test('assertPublicUrl：signal 已取消时不解析域名，直接抛出取消原因', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(
    assertPublicUrl('http://localhost/', { signal: controller.signal }),
    (err) => {
      assert.equal(err, reason);
      return true;
    },
  );
});

function lookup(hostname: string, all: boolean) {
  return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => {
    guardedLookup(hostname, { all }, (err, address, family) => resolve({ err, address, family }));
  });
}

test('guardedLookup：解析结果含回环地址时报错（all 为 true / false 两种调用方式）', async () => {
  for (const all of [true, false]) {
    const { err } = await lookup('localhost', all);
    assert.ok(err instanceof UrlGuardError);
    assert.match(err.message, /不允许访问内网或保留地址: localhost/);
  }
});

test('guardedLookup：允许内网时按调用方式返回地址列表或单个地址', async () => {
  await withPrivateAllowed(async () => {
    const list = await lookup('localhost', true);
    assert.equal(list.err, null);
    assert.ok(Array.isArray(list.address) && list.address.length > 0);
    const single = await lookup('localhost', false);
    assert.equal(single.err, null);
    assert.equal(typeof single.address, 'string');
    assert.ok(single.family === 4 || single.family === 6);
  });
});

test('guardedLookup：DNS 错误原样传出', async () => {
  const original = dns.lookup;
  const failing = ((_host: string, _opts: unknown, cb: (err: Error) => void) => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), {
      code: 'ENOTFOUND',
    });
    cb(err);
  }) as unknown as typeof dns.lookup;
  dns.lookup = failing;
  try {
    const { err } = await lookup('nope.invalid', true);
    assert.equal((err as NodeJS.ErrnoException).code, 'ENOTFOUND');
  } finally {
    dns.lookup = original;
  }
});

test('assertPublicUrl：域名不存在报 400，暂时失败标记为可重试', async () => {
  const original = dns.lookup;
  let code = 'ENOTFOUND';
  dns.lookup = ((_host: string, _opts: unknown, cb: (err: Error) => void) => {
    cb(Object.assign(new Error(`getaddrinfo ${code}`), { code }));
  }) as unknown as typeof dns.lookup;
  try {
    await assert.rejects(assertPublicUrl('https://nope.invalid/a.mp4'), (err: unknown) => {
      assert.ok(err instanceof UrlGuardError);
      assert.match(err.message, /无法解析域名 nope\.invalid（ENOTFOUND）/);
      assert.equal(err.retryable, false);
      return true;
    });
    code = 'EAI_AGAIN';
    await assert.rejects(assertPublicUrl('https://flaky.example/a.mp4'), (err: unknown) => {
      assert.ok(err instanceof UrlGuardError);
      assert.equal(err.retryable, true);
      return true;
    });
  } finally {
    dns.lookup = original;
  }
});

test('assertPublicUrl：域名解析出的地址里只要有一个是内网就拒绝', async () => {
  const original = dns.lookup;
  dns.lookup = ((
    _host: string,
    _opts: unknown,
    cb: (err: null, a: dns.LookupAddress[]) => void,
  ) => {
    cb(null, [
      { address: '93.184.215.14', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
  }) as unknown as typeof dns.lookup;
  try {
    await assert.rejects(assertPublicUrl('https://mixed.example/a.mp4'), (err: unknown) => {
      assert.ok(err instanceof UrlGuardError);
      assert.match(err.message, /不允许访问内网或保留地址: mixed\.example（解析到 非公网 IP）/);
      return true;
    });
  } finally {
    dns.lookup = original;
  }
});

test('assertPublicUrl：拒绝时不回显域名解析出的地址（客户端不能借此探测内网 DNS），地址只记在服务器日志里', async () => {
  const original = dns.lookup;
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  dns.lookup = ((
    _host: string,
    _opts: unknown,
    cb: (err: null, a: dns.LookupAddress[]) => void,
  ) => {
    cb(null, [{ address: '172.16.4.20', family: 4 }]);
  }) as unknown as typeof dns.lookup;
  try {
    for (const url of ['http://metadata.internal/a', 'http://db.corp.example/a.mp4']) {
      await assert.rejects(assertPublicUrl(url), (err: unknown) => {
        assert.ok(err instanceof UrlGuardError);
        assert.match(err.message, /不允许访问内网或保留地址/);
        assert.equal(err.message.includes('172.16.4.20'), false, err.message);
        return true;
      });
    }
    // 连接时的第二道检查（guardedLookup）同样不回显
    const { err } = await lookup('db.corp.example', true);
    assert.ok(err instanceof UrlGuardError);
    assert.equal(err.message.includes('172.16.4.20'), false, err.message);
    assert.ok(logged.some((line) => line.includes('172.16.4.20')));
  } finally {
    dns.lookup = original;
    console.warn = warn;
  }
  // localhost 解析到回环地址：同样不回显 ::1 / 127.0.0.1
  await assert.rejects(assertPublicUrl('http://localhost/a.mp4'), (err: unknown) => {
    assert.ok(err instanceof UrlGuardError);
    assert.equal(/::1|127\.0\.0\.1/.test(err.message), false, err.message);
    return true;
  });
});

test('publicDispatcher：连接时拦截内网 IP 字面量，即使调用方跳过了 assertPublicUrl', async () => {
  const before = hits;
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/`, { dispatcher: publicDispatcher }),
    (err) => {
      const blocked = findUrlGuardError(err);
      assert.ok(blocked, '错误链里应有 UrlGuardError');
      assert.match(blocked.message, /127\.0\.0\.1/);
      return true;
    },
  );
  assert.equal(hits, before);
});

test('publicDispatcher：连接时重新解析域名，解析到内网就拒绝（防 DNS rebinding）', async () => {
  const before = hits;
  await assert.rejects(
    fetch(`http://localhost:${port}/`, { dispatcher: publicDispatcher }),
    (err) => {
      assert.match(findUrlGuardError(err)?.message ?? '', /localhost（解析到 /);
      return true;
    },
  );
  assert.equal(hits, before);
});

test('DNS rebinding：检查时解析到公网、连接时解析到回环，下载被拦下且服务器没收到请求', async () => {
  const original = dns.lookup;
  let calls = 0;
  dns.lookup = ((
    _host: string,
    _opts: unknown,
    cb: (err: null, a: dns.LookupAddress[]) => void,
  ) => {
    calls++;
    const address = calls === 1 ? '93.184.215.14' : '127.0.0.1';
    cb(null, [{ address, family: 4 }]);
  }) as unknown as typeof dns.lookup;
  const before = hits;
  try {
    await assert.rejects(
      downloadFile(
        `http://rebind.example:${port}/`,
        path.join(os.tmpdir(), `ffsvc-rebind-${process.pid}.bin`),
        {
          retries: 0,
          idleTimeoutMs: 2000,
        },
      ),
      /不允许访问内网或保留地址: rebind\.example（解析到 非公网 IP）/,
    );
  } finally {
    dns.lookup = original;
  }
  assert.ok(calls >= 2, '连接时应重新解析');
  assert.equal(hits, before);
});

test('publicDispatcher：允许内网时正常连接', async () => {
  await withPrivateAllowed(async () => {
    const res = await fetch(`http://localhost:${port}/`, { dispatcher: publicDispatcher });
    assert.equal(await res.text(), 'ok');
  });
});

test('findUrlGuardError：只在 cause 链里找，不误判其他错误', () => {
  const guard = new UrlGuardError('x');
  assert.equal(findUrlGuardError(new Error('fetch failed', { cause: guard })), guard);
  assert.equal(findUrlGuardError(new AggregateError([new Error('a'), guard])), guard);
  assert.equal(
    findUrlGuardError(new Error('fetch failed', { cause: new Error('ECONNRESET') })),
    undefined,
  );
  assert.equal(findUrlGuardError('boom'), undefined);
});
