import fs from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { fetch, type Response } from 'undici';
import { assertPublicUrl, findUrlGuardError, publicDispatcher } from './url-guard';

// publicDispatcher 只走 HTTP/1.1（原因见 url-guard.ts），并在建立连接时再查一次地址，防 DNS rebinding。
// 重定向自己跟：fetch 自动跟随时不会让我们检查中间的 Location，一个公网地址就能 302 到 169.254.169.254
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface DownloadOptions {
  /** 失败后的额外重试次数，0 表示只尝试一次 */
  retries: number;
  /** 连续多久收不到数据就判定为卡死并重试 */
  idleTimeoutMs: number;
  /** 首次重试的等待时间，之后指数翻倍 */
  retryBaseDelayMs?: number;
  signal?: AbortSignal;
  /** 每次决定重试前回调，用来打日志；attempt 从 1 开始 */
  onRetry?: (info: { url: string; attempt: number; delayMs: number; reason: string }) => void;
  /** 单个文件解码后的最大字节数，超过即中止且不重试 */
  maxBytes?: number;
}

// 我们请求的是 identity，但服务器可以无视它。fetch 会按 Content-Encoding 自动解压且没有大小上限：
// 841 字节的 br 响应能解出 1 GiB 写满磁盘；Node 24.22.0、26.12.0 及更早版本的 Brotli 解码器还有越界写
// （CVE-2026-111497）。所以只接受 gzip / deflate，其余编码直接拒绝，再加上解码后的字节上限
const ALLOWED_ENCODINGS = new Set(['identity', 'gzip', 'x-gzip', 'deflate']);

/** 下载失败的类别，同步接口据此回复 4xx / 5xx：链接本身的问题（对方 4xx、被拦截、太大）是客户端错误 */
export interface DownloadErrorDetails {
  /** 对方服务器的 HTTP 状态码 */
  status?: number;
  code?: 'too-large' | 'blocked';
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly details: DownloadErrorDetails = {},
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** fetch 的网络错误只说 "fetch failed"，真正原因在 cause 链里 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 4; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ') || '未知错误';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 检查地址后发 GET；SSRF 拦截不重试，DNS 暂时失败按网络错误重试 */
async function guardedGet(url: string, signal: AbortSignal): Promise<Response> {
  try {
    await assertPublicUrl(url, { signal });
    // identity 编码保证 content-length 就是实际字节数，下面才能校验文件是否完整
    return await fetch(url, {
      dispatcher: publicDispatcher,
      signal,
      redirect: 'manual',
      headers: { 'accept-encoding': 'identity' },
    });
  } catch (err) {
    const blocked = findUrlGuardError(err);
    if (blocked) throw new DownloadError(blocked.message, blocked.retryable, { code: 'blocked' });
    throw err;
  }
}

/** 跟随最多 MAX_REDIRECTS 次重定向，每一跳的目标都要过 SSRF 检查 */
async function fetchFollowingRedirects(
  url: string,
  signal: AbortSignal,
  onHop: () => void,
): Promise<Response> {
  let current = url;
  for (let hops = 0; ; hops++) {
    const res = await guardedGet(current, signal);
    const location = res.headers.get('location');
    if (!REDIRECT_STATUS.has(res.status) || !location) return res;
    await res.body?.cancel().catch(() => {});
    if (hops >= MAX_REDIRECTS) {
      throw new DownloadError(`重定向超过 ${MAX_REDIRECTS} 次`, false);
    }
    try {
      current = new URL(location, current).href;
    } catch {
      throw new DownloadError(`重定向地址无效: ${location.slice(0, 200)}`, false);
    }
    onHop();
  }
}

async function downloadOnce(url: string, dest: string, opts: DownloadOptions): Promise<number> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(opts.signal!.reason);
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let idleTimer: NodeJS.Timeout | undefined;
  let idleTimedOut = false;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, opts.idleTimeoutMs);
  };

  try {
    resetIdle();
    const res = await fetchFollowingRedirects(url, controller.signal, resetIdle);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new DownloadError(`HTTP ${res.status}`, RETRYABLE_STATUS.has(res.status), {
        status: res.status,
      });
    }

    const encoding = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
    if (!ALLOWED_ENCODINGS.has(encoding)) {
      await res.body.cancel().catch(() => {});
      throw new DownloadError(`不支持的 Content-Encoding: ${encoding}`, false);
    }
    const lengthHeader = res.headers.get('content-length');
    const expected = lengthHeader && encoding === 'identity' ? Number(lengthHeader) : undefined;

    const max = opts.maxBytes;
    const tooBig = () =>
      new DownloadError(`文件超过 ${Math.round((max ?? 0) / 1024 / 1024)} MB 上限`, false, {
        code: 'too-large',
      });
    if (max !== undefined && expected !== undefined && expected > max) {
      await res.body.cancel().catch(() => {});
      throw tooBig();
    }

    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (max !== undefined && bytes > max) return cb(tooBig());
        resetIdle();
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      counter,
      fs.createWriteStream(dest),
      { signal: controller.signal },
    );

    if (expected !== undefined && Number.isFinite(expected) && bytes !== expected) {
      throw new DownloadError(`文件不完整，收到 ${bytes} 字节，应为 ${expected} 字节`, true);
    }
    return bytes;
  } catch (err) {
    if (idleTimedOut) {
      throw new DownloadError(`超过 ${opts.idleTimeoutMs / 1000} 秒没有收到数据`, true);
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 下载单个文件，网络错误、超时、5xx、文件不完整都会重试，失败时不留下半截文件。
 * 返回写入的字节数。
 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: DownloadOptions,
): Promise<number> {
  const baseDelay = opts.retryBaseDelayMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadOnce(url, dest, opts);
    } catch (err) {
      await fs.promises.rm(dest, { force: true }).catch(() => {});
      if (opts.signal?.aborted) throw err;
      const retryable = !(err instanceof DownloadError) || err.retryable;
      if (!retryable || attempt >= opts.retries) {
        const tried = attempt > 0 ? `（已重试 ${attempt} 次）` : '';
        throw new DownloadError(
          `下载失败${tried} ${url}: ${describeError(err)}`,
          false,
          err instanceof DownloadError ? err.details : {},
        );
      }
      const delayMs = Math.round(baseDelay * 2 ** attempt + Math.random() * baseDelay * 0.5);
      opts.onRetry?.({ url, attempt: attempt + 1, delayMs, reason: describeError(err) });
      await sleep(delayMs, opts.signal);
    }
  }
}

export interface DownloadJob {
  url: string;
  dest: string;
}

/**
 * 用固定数量的并发槽下载一组文件。任何一个文件最终失败就中止其余下载，
 * 并且等所有在途请求都停下后才返回，调用方可以放心清理文件。
 */
export async function downloadAll(
  jobs: DownloadJob[],
  opts: DownloadOptions & { concurrency: number; onFileDone?: (index: number) => void },
): Promise<void> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(opts.signal!.reason);
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let next = 0;
  let firstError: unknown;
  const slot = async () => {
    while (!controller.signal.aborted) {
      const index = next++;
      if (index >= jobs.length) return;
      try {
        await downloadFile(jobs[index].url, jobs[index].dest, {
          ...opts,
          signal: controller.signal,
        });
        opts.onFileDone?.(index);
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
          controller.abort(err);
        }
        return;
      }
    }
  };

  try {
    const slots = Math.max(1, Math.min(opts.concurrency, jobs.length));
    await Promise.all(Array.from({ length: slots }, slot));
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
  if (firstError !== undefined) throw firstError;
  if (opts.signal?.aborted) throw opts.signal.reason;
}
