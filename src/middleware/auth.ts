import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';

const sha256 = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();

/**
 * 请求里带的所有候选 Key：Authorization: Bearer <key>、X-API-Key、查询参数 api_key。
 * 查询参数是给 EventSource（SSE 进度）用的，它不能自定义请求头；代价是 Key 会出现在访问日志、
 * 代理日志和浏览器历史里，能用请求头时优先用请求头
 */
export function extractApiKeys(req: Request): string[] {
  const keys: string[] = [];
  const bearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.get('authorization') ?? '');
  if (bearer) keys.push(bearer[1]);
  const header = req.get('x-api-key')?.trim();
  if (header) keys.push(header);
  const query = req.query?.api_key;
  if (typeof query === 'string' && query) keys.push(query);
  return keys;
}

/**
 * 常数时间比较：两边先做 sha256 变成等长摘要再 timingSafeEqual，长度和内容都不会从耗时泄露；
 * 每个配置的 Key 都比较一遍，不在第一次命中时提前返回
 */
export function isValidApiKey(candidate: string): boolean {
  const given = sha256(candidate);
  let matched = false;
  for (const key of config.apiKeys) {
    matched = crypto.timingSafeEqual(given, sha256(key)) || matched;
  }
  return matched;
}

function reject(res: Response): void {
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer')
    .set('Cache-Control', 'no-store')
    .json({ success: false, error: '缺少或无效的 API Key' });
}

/** 校验 API Key（Authorization: Bearer <key>、X-API-Key 或 ?api_key=）。config.apiKeys 为空时直接放行 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  // CORS 预检不带自定义头，也不执行任何操作
  if (config.apiKeys.length === 0 || req.method === 'OPTIONS') return next();
  if (extractApiKeys(req).some(isValidApiKey)) return next();
  reject(res);
}

/** /api/files 下载用：只有 PROTECT_FILES=true 时才要求 API Key */
export function requireApiKeyForFiles(req: Request, res: Response, next: NextFunction): void {
  if (!config.protectFiles) return next();
  requireApiKey(req, res, next);
}

/** 打日志前把 URL 里的 api_key 查询参数换成 ***，避免 Key 落进日志 */
export function redactApiKey(url: string): string {
  return url.replace(/([?&]api_key=)[^&#]*/gi, '$1***');
}
