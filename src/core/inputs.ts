import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { HttpError } from '../middleware/error';
import type { InputKind, InputSlot } from '../operations/types';
import { DownloadError, downloadAll, type DownloadJob } from '../utils/download';
import { assertPublicUrl, UrlGuardError } from '../utils/url-guard';

/** 队列里的输入：上传文件是 uploads 目录里的绝对路径，链接在 Worker 里下载 */
export type JobInput = { path: string } | { url: string };
export type JobInputs = Record<string, JobInput[]>;

/** 所有操作都接受的通用字段，在参数校验前从请求体里取出 */
export const COMMON_FIELDS = ['callbackUrl'] as const;

const MAX_URL_LENGTH = 4096;

/** 槽接受的 URL 字段名：显式的 urlFields，否则单文件槽 `${name}Url`、多文件槽 `${name}Urls`，名为 file 的槽再加 url */
export function urlFieldsOf(slot: InputSlot): string[] {
  if (slot.urlFields?.length) return [...slot.urlFields];
  const fields = [slot.multiple ? `${slot.name}Urls` : `${slot.name}Url`];
  if (slot.name === 'file') fields.unshift('url');
  return fields;
}

export function isHttpUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const shorten = (value: string) => (value.length > 120 ? `${value.slice(0, 120)}…` : value);

/** 一个链接字段的值（字符串或字符串数组）→ 链接列表，空串视为没传。label 用在错误信息里 */
export function parseUrlList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const urls: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new HttpError(400, `${label} 必须是链接字符串或字符串数组`);
    }
    const url = item.trim();
    if (!url) continue;
    if (!isHttpUrl(url)) {
      throw new HttpError(400, `${label} 不是有效的 http / https 链接: ${shorten(url)}`);
    }
    urls.push(url);
  }
  return urls;
}

/** 取出并删除一个 URL 字段 */
function takeUrls(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  delete body[field];
  return parseUrlList(value, field);
}

/** 取出 callbackUrl：可选，必须是 http(s) 链接 */
export function takeCallbackUrl(body: Record<string, unknown>): string | undefined {
  const value = body.callbackUrl;
  delete body.callbackUrl;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'callbackUrl 必须是链接字符串');
  const url = value.trim();
  if (!url) return undefined;
  if (!isHttpUrl(url)) {
    throw new HttpError(400, `callbackUrl 不是有效的 http / https 链接: ${shorten(url)}`);
  }
  return url;
}

export interface ResolvedInputs {
  inputs: JobInputs;
  /** 每个槽实际收到的文件数（上传或链接），没提供的槽为 0 */
  provided: Record<string, number>;
  /** 所有输入链接，入队前要逐个做 SSRF 检查 */
  urls: string[];
}

export function rangeText(slot: InputSlot): string {
  if (!slot.multiple) return '';
  const { min, max } = slot.multiple;
  return min === max ? `（${min} 个）` : `（${min}-${max} 个）`;
}

/**
 * 合并上传文件和 URL 字段，检查必填、数量、上传与链接不能混用。
 * 会从 body 里删掉所有 URL 字段，剩下的才是操作参数。paramKeys 是操作参数名（与槽同名的参数不当成误用的链接）。
 * 不合格时抛 HttpError(400)
 */
export function resolveRequestInputs(
  slots: readonly InputSlot[],
  paramKeys: ReadonlySet<string>,
  uploads: Record<string, readonly { path: string }[]>,
  body: Record<string, unknown>,
): ResolvedInputs {
  const inputs: JobInputs = {};
  const provided: Record<string, number> = {};
  const urls: string[] = [];

  for (const slot of slots) {
    const fields = urlFieldsOf(slot);
    // 把链接写进文件字段是常见误用（JSON 里写 "file": "https://…"），不提示的话参数校验会把它当未知字段丢掉，
    // 客户端只会看到「请上传文件」
    if (!fields.includes(slot.name) && !paramKeys.has(slot.name)) {
      const misplaced = body[slot.name];
      delete body[slot.name];
      if (typeof misplaced === 'string' && misplaced.trim()) {
        throw new HttpError(
          400,
          `${slot.name} 字段只能上传文件（multipart/form-data），链接请放在 ${fields.join(' / ')} 字段`,
        );
      }
    }

    const files = uploads[slot.name] ?? [];
    const slotUrls = fields.flatMap((field) => takeUrls(body, field));
    if (files.length && slotUrls.length) {
      throw new HttpError(
        400,
        `${slot.name} 不能同时上传文件和提供链接（${fields.join(' / ')}），请二选一`,
      );
    }

    const count = files.length + slotUrls.length;
    provided[slot.name] = count;
    if (count === 0) {
      if (slot.required) {
        throw new HttpError(
          400,
          `请上传 ${slot.name} 文件${rangeText(slot)}，或提供 ${fields.join(' / ')} 链接`,
        );
      }
      continue;
    }
    const max = slot.multiple?.max ?? 1;
    if (count > max) {
      throw new HttpError(
        400,
        slot.multiple
          ? `${slot.name} 最多 ${max} 个文件，收到 ${count} 个`
          : `${slot.name} 只能提供 1 个文件，收到 ${count} 个`,
      );
    }
    if (slot.multiple && count < slot.multiple.min) {
      throw new HttpError(
        400,
        `${slot.name} 至少需要 ${slot.multiple.min} 个文件（上传或链接），收到 ${count} 个`,
      );
    }
    inputs[slot.name] = files.length
      ? files.map((f) => ({ path: f.path }))
      : slotUrls.map((url) => ({ url }));
    urls.push(...slotUrls);
  }
  return { inputs, provided, urls };
}

/**
 * SSRF 检查。url-guard 抛的 HttpError(400) 原样传出；DNS 暂时解析不了（EAI_AGAIN 之类）是 503，客户端重试即可；
 * 其他错误同样是链接本身的问题，按 400 返回，而不是让客户端以为服务挂了
 */
export async function assertPublicUrls(urls: readonly string[]): Promise<void> {
  for (const url of new Set(urls)) {
    try {
      await assertPublicUrl(url);
    } catch (err) {
      if (err instanceof UrlGuardError && err.retryable) {
        throw new HttpError(503, `暂时无法解析链接的域名，请稍后重试: ${shorten(url)}`);
      }
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `链接不可用: ${shorten(url)}: ${(err as Error).message}`);
    }
  }
}

/** 取 URL 路径里的扩展名，让下载下来的临时文件保留原格式的提示 */
export function urlExtension(url: string, fallback: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

const FALLBACK_EXT: Record<InputKind, string> = {
  video: '.mp4',
  audio: '',
  image: '',
  subtitle: '',
  media: '',
  any: '',
};

export function isInside(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 要落到本地的输入槽。label 是错误信息里的名字，默认 name（pipeline 的槽名带步骤前缀，label 是原槽名） */
export interface MaterializeSlot {
  name: string;
  kind: InputKind;
  label?: string;
}

export interface MaterializeOptions {
  signal: AbortSignal;
  /** 每下载完一个文件回调一次 */
  onDownloaded?: (done: number, total: number) => void;
  log?: (message: string) => void;
}

/** 链接输入数量（决定有没有下载阶段） */
export function countUrlInputs(inputs: JobInputs): number {
  return Object.values(inputs).reduce(
    (sum, items) => sum + items.filter((item) => 'url' in item).length,
    0,
  );
}

/**
 * 把队列里的输入变成本地文件：上传文件校验仍在 uploads 目录里且存在，链接带重试地下载到 workDir。
 * 返回按槽名索引的本地绝对路径（ctx.inputs）。slots 一般是 op.inputs；pipeline 把所有步骤的槽改名后合在一起，
 * 一次下载完
 */
export async function materializeInputs(
  slots: readonly MaterializeSlot[],
  inputs: JobInputs,
  workDir: string,
  opts: MaterializeOptions,
): Promise<Record<string, string[]>> {
  const local: Record<string, string[]> = {};
  const jobs: DownloadJob[] = [];
  let index = 0;

  for (const slot of slots) {
    const items = inputs[slot.name];
    if (!items?.length) continue;
    local[slot.name] = [];
    for (const item of items) {
      if ('url' in item) {
        const dest = path.join(
          workDir,
          `input-${index++}${urlExtension(item.url, FALLBACK_EXT[slot.kind])}`,
        );
        jobs.push({ url: item.url, dest });
        local[slot.name].push(dest);
        continue;
      }
      // 路径来自 Redis 里的 job，只信任 uploads 目录下的文件
      if (!isInside(config.uploadDir, item.path)) {
        throw new Error(`输入文件不在上传目录内，拒绝处理: ${path.basename(item.path)}`);
      }
      const stat = await fs.promises.stat(item.path).catch(() => undefined);
      if (!stat?.isFile()) {
        throw new Error(
          `上传的 ${slot.label ?? slot.name} 文件已不存在（可能已被清理），请重新提交`,
        );
      }
      local[slot.name].push(path.resolve(item.path));
    }
  }

  if (jobs.length) {
    // 入队时检查过一次，这里再查：排队期间域名可能被改指向内网（DNS rebinding）
    await assertPublicUrls(jobs.map((job) => job.url));
    let done = 0;
    opts.onDownloaded?.(0, jobs.length);
    opts.log?.(`下载 ${jobs.length} 个输入文件（并发=${config.downloadConcurrency}）`);
    await downloadAll(jobs, {
      concurrency: config.downloadConcurrency,
      retries: config.downloadRetries,
      idleTimeoutMs: config.downloadIdleTimeoutMs,
      maxBytes: config.downloadMaxBytes,
      signal: opts.signal,
      onRetry: ({ url, attempt, delayMs, reason }) => {
        opts.log?.(
          `下载重试 ${attempt}/${config.downloadRetries}，${delayMs}ms 后重试 ${url}: ${reason}`,
        );
      },
      onFileDone: () => {
        done++;
        opts.onDownloaded?.(done, jobs.length);
      },
    });
  }
  return local;
}

/**
 * 同步接口里下载输入失败时换成合适的 HTTP 状态：链接本身的问题（对方 4xx、指向内网、文件太大）是 400 / 413，
 * 对方 5xx 或网络失败是 502。异步任务不用：下载失败写进 task.error
 */
export function downloadErrorToHttp(err: unknown): unknown {
  if (!(err instanceof DownloadError)) return err;
  const { status, code } = err.details;
  if (code === 'too-large') return new HttpError(413, err.message);
  if (code === 'blocked' || (status !== undefined && status >= 400 && status < 500)) {
    return new HttpError(400, err.message);
  }
  return new HttpError(502, err.message);
}
