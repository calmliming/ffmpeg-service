import dns from 'dns';
import net, { type LookupFunction } from 'net';
import { Agent, buildConnector } from 'undici';
import { config } from '../config';
import { HttpError } from '../middleware/error';

// 出站请求（下载输入文件、发送回调）的 SSRF 防护，两道关：
// 1. assertPublicUrl：每次发请求前（包括每一跳重定向）解析域名，任一地址是内网 / 保留地址就拒绝；
// 2. publicDispatcher：真正建立 TCP 连接时再查一次解析结果，防止检查和连接之间 DNS 被改指向内网（DNS rebinding）。
// 两道都读 config.allowPrivateUrls，ALLOW_PRIVATE_URLS=true 时全部放行

/** URL 不允许访问。status 固定 400；retryable 只在 DNS 暂时失败时为 true，下载可以据此重试 */
export class UrlGuardError extends HttpError {
  readonly code = 'ERR_URL_NOT_ALLOWED';

  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(400, message);
    this.name = 'UrlGuardError';
  }
}

const IPV4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // 「本网络」，Linux 上连 0.0.0.0 等于连本机
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // 链路本地，含云厂商元数据服务 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

const IPV6_BLOCKED: [string, number][] = [
  // 比 ::/128、::1/128 更宽：::/96 是已废弃的「IPv4 兼容地址」，公网上不存在
  ['::', 96],
  ['100::', 64], // 丢弃前缀
  ['2001:db8::', 32], // 文档示例
  ['3fff::', 20], // 文档示例（RFC 9637）
  ['64:ff9b:1::', 48], // 本地 NAT64（RFC 8215），内嵌 IPv4 的位置随前缀长度变化，整段拒绝
  ['::ffff:0:0:0', 96], // SIIT「IPv4 转换地址」（RFC 2765），公网上不存在
  ['fc00::', 7], // 唯一本地地址
  ['fe80::', 10], // 链路本地
  ['fec0::', 10], // 已废弃的站点本地地址，部分系统仍然路由
  ['ff00::', 8], // 组播
];

const blockList = new net.BlockList();
for (const [address, prefix] of IPV4_BLOCKED) blockList.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of IPV6_BLOCKED) blockList.addSubnet(address, prefix, 'ipv6');

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** 合法 IPv6 文本 → 8 个 16 位整数；末尾可以是点分 IPv4（::ffff:127.0.0.1） */
function ipv6Hextets(address: string): number[] | undefined {
  if (!net.isIPv6(address)) return undefined;
  let text = address;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const split = text.split('::');
  const head = split[0] ? split[0].split(':') : [];
  const tail = split.length > 1 && split[1] ? split[1].split(':') : [];
  const zeros = split.length > 1 ? Array(8 - head.length - tail.length).fill('0') : [];
  const groups = [...head, ...zeros, ...tail].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n)) ? groups : undefined;
}

const hextetsToIPv4 = (high: number, low: number) =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/**
 * 取出 IPv6 地址里内嵌的 IPv4：IPv4 映射（::ffff:a.b.c.d）、NAT64（64:ff9b::/96）、
 * 6to4（2002:AABB:CCDD::/16）、Teredo（2001:0::/32，客户端地址按位取反存放）。
 * 这些地址最终会被转发到内嵌的 IPv4，必须按 IPv4 规则再查一次
 */
export function embeddedIPv4(address: string): string | undefined {
  const h = ipv6Hextets(address);
  if (!h) return undefined;
  const zeroUntil = (end: number) => h.slice(0, end).every((n) => n === 0);
  if (zeroUntil(5) && h[5] === 0xffff) return hextetsToIPv4(h[6], h[7]);
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0)) {
    return hextetsToIPv4(h[6], h[7]);
  }
  if (h[0] === 0x2002) return hextetsToIPv4(h[1], h[2]);
  if (h[0] === 0x2001 && h[1] === 0) return hextetsToIPv4(h[6] ^ 0xffff, h[7] ^ 0xffff);
  return undefined;
}

/**
 * 地址是否属于内网、回环、链路本地、组播、文档示例等非公网范围。
 * 接受带方括号或 zone id 的 IPv6；不是合法 IP 的字符串一律视为不安全
 */
export function isNonPublicAddress(address: string): boolean {
  const bare = stripBrackets(address.trim()).replace(/%.*$/, '');
  const family = net.isIP(bare);
  if (family === 4) return blockList.check(bare, 'ipv4');
  if (family !== 6) return true;
  if (blockList.check(bare, 'ipv6')) return true;
  const v4 = embeddedIPv4(bare);
  return v4 !== undefined && blockList.check(v4, 'ipv4');
}

const PRIVATE_HINT = '（内网部署需要时可设置 ALLOW_PRIVATE_URLS=true）';

/**
 * 不回显域名解析出的地址：客户端能借此读出服务器侧的 DNS 结果，摸清内网服务名对应的内网地址。
 * 具体地址只记在服务器日志里，排查时看日志
 */
function blockedAddressError(host: string, address: string): UrlGuardError {
  const literal = stripBrackets(host) === address;
  if (!literal) console.warn(`[UrlGuard] 拒绝访问 ${host}：解析到非公网地址 ${address}`);
  const resolved = literal ? '' : '（解析到 非公网 IP）';
  return new UrlGuardError(`不允许访问内网或保留地址: ${host}${resolved}${PRIVATE_HINT}`);
}

// 这些 getaddrinfo 错误通常是暂时的，下载可以重试；ENOTFOUND / ENODATA 说明域名本身不存在
const TRANSIENT_DNS_CODES = new Set(['EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']);
const LOOKUP_TIMEOUT_MS = 10_000;

function lookupAll(host: string, signal?: AbortSignal): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    // getaddrinfo 跑在 libuv 线程池里没法取消，超时后只是不再等它
    const timer = setTimeout(() => {
      finish();
      reject(new UrlGuardError(`解析域名 ${host} 超时`, true));
    }, LOOKUP_TIMEOUT_MS);
    const onAbort = () => {
      finish();
      reject(signal!.reason);
    };
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    dns.lookup(host, { all: true }, (err, addresses) => {
      if (signal?.aborted) return;
      finish();
      if (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        const transient = TRANSIENT_DNS_CODES.has(code);
        return reject(new UrlGuardError(`无法解析域名 ${host}（${code}）`, transient));
      }
      if (addresses.length === 0) {
        return reject(new UrlGuardError(`无法解析域名 ${host}（没有地址）`));
      }
      resolve(addresses);
    });
  });
}

/**
 * 出站 URL 检查：只允许 http / https，不允许 URL 里带用户名密码；除非 ALLOW_PRIVATE_URLS=true，
 * IP 字面量或主机解析出的任一地址是内网、回环、链路本地、组播等保留地址都拒绝。
 * 不合格时抛 UrlGuardError（HttpError 400），信息里带主机名
 */
export async function assertPublicUrl(
  url: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const shown = url.length > 100 ? `${url.slice(0, 100)}…` : url;
    throw new UrlGuardError(`链接格式不正确: ${shown}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlGuardError(`只支持 http 或 https 链接，收到 ${parsed.protocol.replace(/:$/, '')}`);
  }
  const host = parsed.hostname;
  if (parsed.username || parsed.password) {
    throw new UrlGuardError(`链接不能包含用户名或密码: ${host}`);
  }
  if (!host) throw new UrlGuardError('链接缺少主机名');
  if (config.allowPrivateUrls) return;

  // WHATWG URL 已把 0x7f.1、2130706433 这类写法规范成点分十进制，IPv6 带方括号
  const literal = stripBrackets(host);
  if (net.isIP(literal)) {
    if (isNonPublicAddress(literal)) throw blockedAddressError(host, literal);
    return;
  }
  const addresses = await lookupAll(host, opts.signal);
  const bad = addresses.find((entry) => isNonPublicAddress(entry.address));
  if (bad) throw blockedAddressError(host, bad.address);
}

/** 在错误的 cause 链里找 UrlGuardError（fetch 的连接错误只说 "fetch failed"，真正原因在 cause 里） */
export function findUrlGuardError(err: unknown): UrlGuardError | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof UrlGuardError) return current;
    if (current instanceof AggregateError) {
      const inner = current.errors.find((e) => e instanceof UrlGuardError);
      if (inner) return inner as UrlGuardError;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * 连接时用的 DNS 解析：包住 dns.lookup，解析结果里有任一非公网地址就让连接失败。
 * net.connect 开启 autoSelectFamily（Node 20 起默认）时用 all: true 调用，否则要单个地址，两种都要支持
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, options.all ? [] : '');
    if (!config.allowPrivateUrls) {
      const bad = addresses.find((entry) => isNonPublicAddress(entry.address));
      if (bad) return callback(blockedAddressError(hostname, bad.address), options.all ? [] : '');
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) return callback(new UrlGuardError(`无法解析域名 ${hostname}（没有地址）`), '');
    callback(null, first.address, first.family);
  });
};

// undici 8（Node 26 自带，也是本项目依赖的 npm 包）默认协商 HTTP/2，cdn.musegen.ai 走 h2 时单连接窗口太小，
// 6 个文件实测 90-100 s，HTTP/1.1 只要约 22 s（2026-10-26）。所以显式用 undici 包的 fetch 并关掉 h2，
// 这样无论跑在哪个 Node 大版本上都走 HTTP/1.1。
// 不能把这个 Agent 传给 Node 24 的全局 fetch：两边 undici 版本不同，会报 invalid onRequestStart method。
// buildConnector 自己的 allowH2 默认是 true，传了自定义 connect 后 Agent 的 allowH2 管不到 ALPN，两处都要关
const baseConnector = buildConnector({ allowH2: false, lookup: guardedLookup });

// IP 字面量不走 lookup，所以连接前单独检查一次
const guardedConnect: buildConnector.connector = (options, callback) => {
  const host = stripBrackets(options.hostname);
  if (!config.allowPrivateUrls && net.isIP(host) && isNonPublicAddress(host)) {
    callback(blockedAddressError(host, host), null);
    return;
  }
  baseConnector(options, callback);
};

/** 创建带 SSRF 连接检查、只走 HTTP/1.1 的 undici Agent。只能配合 undici 包的 fetch 使用 */
export function createPublicAgent(options: Omit<Agent.Options, 'connect' | 'allowH2'> = {}): Agent {
  return new Agent({ ...options, allowH2: false, connect: guardedConnect });
}

/** 所有出站请求（下载、回调）共用的 dispatcher */
export const publicDispatcher = createPublicAgent();
