import fs from 'fs';
import path from 'path';
import express, { Router } from 'express';
import { config } from '../config';

/** 只删输出目录顶层的单个文件。HLS 这类多文件产物在子目录里，播放器会反复请求同一批分片，取一次就删会播放失败 */
function topLevelFile(requestPath: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(requestPath).replace(/^\/+/, '');
  } catch {
    return undefined;
  }
  if (!rel || /[\\/]/.test(rel) || rel === '.' || rel === '..') return undefined;
  return path.join(config.outputDir, rel);
}

/** 输出文件下载（/api/files）。SAVE_OUTPUT_FILE=false 时顶层文件被完整下载一次后删除 */
export function createFilesRouter(): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!config.saveOutputFile) {
      // 确保文件完全发送后再删除；HEAD 也会返回 200，只在真正下载（GET）后删除
      res.on('finish', () => {
        if (req.method !== 'GET' || res.statusCode !== 200) return;
        const file = topLevelFile(req.path);
        if (file) fs.unlink(file, () => {});
      });
    }
    next();
  });
  router.use(
    express.static(config.outputDir, {
      index: false,
      redirect: false,
      // 产物和本服务同源，禁止浏览器按内容猜类型，防止被当成 HTML 执行
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    }),
  );
  return router;
}
