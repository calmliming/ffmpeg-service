import { Router } from 'express';
import { version } from '../../package.json';
import { config } from '../config';
import type { OperationInfo } from '../core/catalog';
import { buildOpenApiDocument } from '../core/openapi';

/** GET /api/openapi.json。文档随鉴权配置变化（安全方案、下载是否要 Key），按配置缓存生成结果 */
export function createOpenApiRouter(catalog: readonly OperationInfo[]): Router {
  const router = Router();
  const cache = new Map<string, string>();
  router.get('/', (_req, res) => {
    const opts = {
      version,
      serverUrl: config.publicBaseUrl || '/',
      authEnabled: config.apiKeys.length > 0,
      protectFiles: config.protectFiles,
      maxUploadMb: Math.round(config.maxFileSize / 1024 / 1024),
    };
    const key = JSON.stringify(opts);
    let body = cache.get(key);
    if (!body) {
      body = JSON.stringify(buildOpenApiDocument(catalog, opts));
      cache.set(key, body);
    }
    res.type('application/json').send(body);
  });
  return router;
}
