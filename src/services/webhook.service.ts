import crypto from 'crypto';
import { fetch } from 'undici';
import { version } from '../../package.json';
import { config } from '../config';
import { describeError } from '../utils/download';
import { assertPublicUrl, findUrlGuardError, publicDispatcher } from '../utils/url-guard';

export interface WebhookDeliveryResult {
  delivered: boolean;
  attempts: number;
  /** 最后一次收到的 HTTP 状态码 */
  status?: number;
  error?: string;
  /** 本次投递的 ID（X-FFmpeg-Service-Delivery），重试时不变，接收方可用来去重 */
  deliveryId?: string;
}

export interface DeliverWebhookOptions {
  event: string;
  signal?: AbortSignal;
  /** 首次重试前的等待（毫秒），之后指数翻倍并加随机抖动，默认 1000。测试时调小 */
  retryBaseDelayMs?: number;
  /** 覆盖 config.webhookRetries */
  retries?: number;
  /** 覆盖 config.webhookTimeoutMs（单次请求超时） */
  timeoutMs?: number;
  /** 每次决定重试前回调，用来打日志；attempt 是即将进行的第几次尝试（从 2 开始） */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export const WEBHOOK_HEADERS = {
  event: 'X-FFmpeg-Service-Event',
  delivery: 'X-FFmpeg-Service-Delivery',
  timestamp: 'X-FFmpeg-Service-Timestamp',
  signature: 'X-FFmpeg-Service-Signature',
  attempt: 'X-FFmpeg-Service-Attempt',
} as const;

const USER_AGENT = `ffmpeg-service/${version}`;
const RETRYABLE_STATUS = new Set([408, 425, 429]);
// 单次退避上限，避免 WEBHOOK_RETRIES 设得很大时一等就是几分钟
const MAX_DELAY_MS = 60_000;

/** sha256=<hex>，HMAC-SHA256(secret, `${timestamp}.${rawBody}`)。时间戳参与签名，截获的请求过了容忍期就不能重放 */
export function signWebhookPayload(
  secret: string,
  timestamp: number | string,
  rawBody: string | Buffer,
): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.`);
  hmac.update(rawBody);
  return `sha256=${hmac.digest('hex')}`;
}

type HeaderSource =
  { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof headers.get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(
    headers as Record<string, string | string[] | undefined>,
  )) {
    if (key.toLowerCase() !== lower) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * 接收方校验回调签名（也用于文档和测试）。rawBody 必须是收到的原始字节，不能是重新序列化的 JSON。
 * 签名头可以有多个逗号分隔的 sha256=...（轮换密钥时），任一匹配即通过；
 * 时间戳与当前时间相差超过 toleranceSeconds（默认 300 秒）视为重放，返回 false
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  headers: HeaderSource,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!secret) return false;
  const timestamp = readHeader(headers, WEBHOOK_HEADERS.timestamp)?.trim() ?? '';
  const signature = readHeader(headers, WEBHOOK_HEADERS.signature) ?? '';
  if (!/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = Buffer.from(signWebhookPayload(secret, timestamp, rawBody));
  let matched = false;
  for (const candidate of signature.split(',')) {
    const given = Buffer.from(candidate.trim());
    // timingSafeEqual 要求等长；长度本身不是秘密
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) matched = true;
  }
  return matched;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface AttemptOutcome {
  ok: boolean;
  retryable: boolean;
  status?: number;
  error?: string;
  retryAfterMs?: number;
}

async function attemptDelivery(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const attemptSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    await assertPublicUrl(url, { signal: attemptSignal });
    const res = await fetch(url, {
      method: 'POST',
      dispatcher: publicDispatcher,
      signal: attemptSignal,
      // 3xx 一律算失败：跟随重定向会把签名过的 POST 转给未经检查的地址
      redirect: 'manual',
      headers,
      body,
    });
    // 只关心状态码，响应体直接丢弃
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300)
      return { ok: true, retryable: false, status: res.status };
    const retryable = RETRYABLE_STATUS.has(res.status) || res.status >= 500;
    const error =
      res.status >= 300 && res.status < 400
        ? `HTTP ${res.status}，回调地址不允许重定向`
        : `HTTP ${res.status}`;
    return {
      ok: false,
      retryable,
      status: res.status,
      error,
      retryAfterMs: retryable ? retryAfterMs(res.headers.get('retry-after')) : undefined,
    };
  } catch (err) {
    if (signal?.aborted) return { ok: false, retryable: false, error: '回调已取消' };
    if (timeout.signal.aborted) {
      return { ok: false, retryable: true, error: `超过 ${timeoutMs / 1000} 秒没有响应` };
    }
    const blocked = findUrlGuardError(err);
    if (blocked) return { ok: false, retryable: blocked.retryable, error: blocked.message };
    return { ok: false, retryable: true, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 向 callbackUrl POST JSON。网络错误、超时、408 / 425 / 429 / 5xx 按 config.webhookRetries 重试（指数退避 + 抖动，
 * 遵守不超过 60 秒的 Retry-After）；其他 4xx 和 3xx 不重试。每次尝试前都做 SSRF 检查。
 * 配置了 WEBHOOK_SECRET 时带 HMAC 签名头。永不抛错，结果通过返回值告诉调用方
 */
export async function deliverWebhook(
  url: string,
  payload: unknown,
  opts: DeliverWebhookOptions = { event: 'task.completed' },
): Promise<WebhookDeliveryResult> {
  const deliveryId = crypto.randomUUID();
  let body: string;
  try {
    body = JSON.stringify(payload) ?? 'null';
  } catch (err) {
    return {
      delivered: false,
      attempts: 0,
      deliveryId,
      error: `回调内容无法序列化为 JSON: ${describeError(err)}`,
    };
  }

  const retries = opts.retries ?? config.webhookRetries;
  const timeoutMs = opts.timeoutMs ?? config.webhookTimeoutMs;
  const baseDelay = opts.retryBaseDelayMs ?? 1000;
  let status: number | undefined;
  const failed = (attempts: number, error = '回调已取消'): WebhookDeliveryResult => ({
    delivered: false,
    attempts,
    ...(status !== undefined ? { status } : {}),
    error,
    deliveryId,
  });

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) return failed(attempt - 1);

    // 每次尝试重新取时间戳并签名，接收方的重放窗口按实际发送时间计算
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      [WEBHOOK_HEADERS.event]: opts.event,
      [WEBHOOK_HEADERS.delivery]: deliveryId,
      [WEBHOOK_HEADERS.timestamp]: String(timestamp),
      [WEBHOOK_HEADERS.attempt]: String(attempt),
    };
    if (config.webhookSecret) {
      headers[WEBHOOK_HEADERS.signature] = signWebhookPayload(
        config.webhookSecret,
        timestamp,
        body,
      );
    }

    const outcome = await attemptDelivery(url, body, headers, timeoutMs, opts.signal);
    status = outcome.status ?? status;
    if (outcome.ok) return { delivered: true, attempts: attempt, status, deliveryId };
    const error = outcome.error ?? '未知错误';
    if (!outcome.retryable || attempt > retries) return failed(attempt, error);

    const backoff = Math.min(
      MAX_DELAY_MS,
      Math.round(baseDelay * 2 ** (attempt - 1) + Math.random() * baseDelay * 0.5),
    );
    const delayMs = Math.max(backoff, Math.min(outcome.retryAfterMs ?? 0, MAX_DELAY_MS));
    opts.onRetry?.({ attempt: attempt + 1, delayMs, reason: error });
    if (!(await sleep(delayMs, opts.signal))) return failed(attempt);
  }
}
