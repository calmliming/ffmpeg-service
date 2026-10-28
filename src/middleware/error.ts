import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { config } from '../config';
import { ApiResponse } from '../types';
import { redactPaths } from '../utils/redact';

// 信息里提到的接口路径（见 GET /api/operations、请用 /api/audio/normalize）。只认不带扩展名、后面不再跟路径字符的，
// /api/uploads/x.mp4 这种真正的文件路径不算
const API_ROUTE = /(?<![\w:/\\])\/api(?:\/[A-Za-z][\w-]*)+(?![\w./\\-])/g;
const ROUTE_MARK = /\uE000(\d+)\uE001/g;

/**
 * 给客户端看的错误信息（HTTP 响应、任务 error、回调）去掉服务器目录。redactPaths 按形状认绝对路径，
 * 接口路径在它看来也像目录，会被删成「请用 normalize」，所以先换成占位符，去完目录再换回来
 */
export function redactForClient(text: string, extraRoots: readonly string[] = []): string {
  const routes: string[] = [];
  const masked = text.replace(API_ROUTE, (route) => `\uE000${routes.push(route) - 1}\uE001`);
  return redactPaths(masked, extraRoots).replace(
    ROUTE_MARK,
    (_, i: string) => routes[Number(i)] ?? '',
  );
}

/** 带 HTTP 状态码的错误，errorHandler 会按 status 返回，而不是一律 500 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type ErrorWithStatus = Error & { status?: number; statusCode?: number; type?: string };

const MULTIPART_CLIENT_ERROR =
  /^(Unexpected end of form|Unexpected end of file|Multipart: Boundary not found|Malformed part header|Malformed urlencoded form|Part terminated early|Unsupported content type|Malformed content type)/;

function multerMessage(err: multer.MulterError): string {
  // @types/multer 还没有 multer 2 新增的 LIMIT_FIELD_NESTING、LIMIT_FIELD_ARRAY_INDEX
  switch (err.code as string) {
    case 'LIMIT_UNEXPECTED_FILE':
      return `不接受的文件字段 ${err.field ?? ''}（字段名不对，或该字段的文件数量超过上限）`;
    case 'LIMIT_FILE_COUNT':
      return '上传的文件数量超过上限';
    case 'LIMIT_PART_COUNT':
      return '表单字段和文件的总数超过上限';
    case 'LIMIT_FIELD_COUNT':
      return '表单字段数量超过上限';
    case 'LIMIT_FIELD_KEY':
      return '表单字段名过长';
    case 'LIMIT_FIELD_VALUE':
      return `表单字段 ${err.field ?? ''} 的值超过 64 KB 上限`;
    case 'LIMIT_FIELD_NESTING':
      return `表单字段名 ${err.field ?? ''} 嵌套过深，最多一层数组（如 timestamps[]）`;
    case 'LIMIT_FIELD_ARRAY_INDEX':
      return `表单字段名 ${err.field ?? ''} 的数组下标过大`;
    case 'MISSING_FIELD_NAME':
      return '表单字段缺少名称';
    default:
      return err.message;
  }
}

function resolveError(err: ErrorWithStatus): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const limitMb = Math.round(config.maxFileSize / 1024 / 1024);
      return { status: 413, message: `文件超过 ${limitMb}MB 上限` };
    }
    return { status: 400, message: `上传参数错误: ${multerMessage(err)}` };
  }
  if (err.type === 'entity.parse.failed') return { status: 400, message: '请求体不是合法的 JSON' };
  if (err.type === 'entity.too.large') {
    return { status: 413, message: '请求体超过 100 KB 上限，请减少一次提交的内容' };
  }
  if (err.type === 'parameters.too.many') return { status: 413, message: '表单参数过多' };
  // multer 2 / busboy 对客户端中断和畸形 multipart 抛的是普通 Error，不映射的话一律变成 500 并打印堆栈。
  // 连接断开时 req 先发 aborted 还是 close 不固定，multer 两种都会报
  if (err.message === 'Request aborted' || err.message === 'Request closed') {
    return { status: 499, message: '客户端中断了上传' };
  }
  if (MULTIPART_CLIENT_ERROR.test(err.message)) {
    return { status: 400, message: `上传请求格式错误: ${err.message}` };
  }
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, message: err.message };
  }
  return { status: 500, message: err.message };
}

export function errorHandler(
  err: ErrorWithStatus,
  _req: Request,
  res: Response<ApiResponse>,
  next: NextFunction,
) {
  const { status, message } = resolveError(err);
  // 主动抛出的 HttpError（如 504 超时）原因已经写在信息里，堆栈没有用
  if (status < 500) console.warn(`[Error ${status}] ${message}`);
  else if (err instanceof HttpError) console.error(`[Error ${status}] ${message}`);
  else console.error(`[Error] ${err.stack ?? err.message}`);
  // 响应已经发完时（例如路由先回复、之后又有中间件报错），交给 next 会让 finalhandler 销毁 socket，
  // 打断复用这个 keep-alive 连接的下一个请求。客户端已断开时也没有可写的地方
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) return next(err);
  // 返回给客户端的信息去掉服务器目录，日志里保留原文便于排查。ffprobe、下载、文件系统的报错常带上传目录的
  // 绝对路径，同步接口（/api/info）和 500 会把它原样回给客户端
  res.status(status).json({ success: false, error: redactForClient(message, redactRoots(res)) });
}

/** 路由在 res.locals.redactRoots 里登记的工作目录（同步接口的 uploads/sync-<id>），里面的文件只留文件名 */
function redactRoots(res: Response): string[] {
  const roots: unknown = res.locals?.redactRoots;
  return Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : [];
}

const REDIS_UNAVAILABLE =
  /max retries per request|Connection is closed|Command timed out|ECONNREFUSED|Stream isn't writeable/i;

export function isRedisUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'MaxRetriesPerRequestError' || REDIS_UNAVAILABLE.test(err.message);
}

/**
 * 路由 catch 块统一出口：HttpError 按自带状态码返回，Redis 不可用返回 503 让客户端重试，
 * 其余按 500 返回原始信息
 */
export function sendServerError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res
      .status(err.status)
      .json({ success: false, error: redactForClient(err.message, redactRoots(res)) });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isRedisUnavailable(err)) {
    console.error(`[Error] Redis 不可用: ${message}`);
    res.status(503).json({ success: false, error: '任务服务暂时不可用，请稍后重试' });
    return;
  }
  console.error(`[Error] ${message}`);
  res.status(500).json({ success: false, error: redactForClient(message, redactRoots(res)) });
}
