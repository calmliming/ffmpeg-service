import path from 'path';
import os from 'os';

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const trimSlash = (value: string | undefined) => (value ?? '').trim().replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT) || 9527,
  uploadDir: path.resolve(__dirname, '../uploads'),
  outputDir: path.resolve(__dirname, '../output'),
  maxFileSize: intEnv('MAX_UPLOAD_MB', 500, 1) * 1024 * 1024,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  saveOutputFile: process.env.SAVE_OUTPUT_FILE !== 'false',
  maxConcurrentTasks: Number(process.env.MAX_CONCURRENT_TASKS) || Math.max(1, os.cpus().length - 1),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // cdn.musegen.ai 在 5 路并发时会频繁掐断 TLS 握手（2026-10-26 实测），默认降到 3 路
  downloadConcurrency: intEnv('DOWNLOAD_CONCURRENCY', 3, 1),
  downloadRetries: intEnv('DOWNLOAD_RETRIES', 3, 0),
  downloadIdleTimeoutMs: intEnv('DOWNLOAD_IDLE_TIMEOUT_SECONDS', 30, 1) * 1000,
  downloadMaxBytes: intEnv('DOWNLOAD_MAX_MB', 1024, 1) * 1024 * 1024,
  // 任务记录过期后客户端只能拿到 404，1 小时太短，默认保留 24 小时
  taskTtlSeconds: intEnv('TASK_TTL_SECONDS', 24 * 60 * 60, 60),

  // 服务对外的地址，例如 https://media.example.com。回调和任务详情里用它拼出绝对下载地址，不设时返回 /api/files/... 相对路径
  publicBaseUrl: trimSlash(process.env.PUBLIC_BASE_URL),
  // 逗号分隔的 API Key。为空时不鉴权，启动时打印警告
  apiKeys: listEnv('API_KEYS'),
  // /api/files 下载是否也要求 API Key。默认不要求：文件名是随机 UUID，下载链接常直接交给浏览器
  protectFiles: process.env.PROTECT_FILES === 'true',
  // 出站请求（下载输入文件、发送回调）默认拒绝内网、回环、链路本地等地址，防止 SSRF；内网部署需要时设为 true
  allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === 'true',
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',
  webhookRetries: intEnv('WEBHOOK_RETRIES', 3, 0),
  webhookTimeoutMs: intEnv('WEBHOOK_TIMEOUT_SECONDS', 10, 1) * 1000,
  // 等待中的任务超过这个数时新提交返回 429；0 表示不限
  maxQueueLength: intEnv('MAX_QUEUE_LENGTH', 0, 0),
  // 本地输出文件保留多少小时，到期由后台清理；0 表示永久保留
  outputRetentionHours: intEnv('OUTPUT_RETENTION_HOURS', 0, 0),
  // 同步接口（如 /api/info）的最长执行时间，排队等空位的时间也算在内
  syncTimeoutMs: intEnv('SYNC_TIMEOUT_SECONDS', 60, 1) * 1000,
  // 同步接口同时执行的请求数，超出的排队（队列长度为它的 8 倍）；0 表示按 max(8, 2 × MAX_CONCURRENT_TASKS)
  syncMaxConcurrency: intEnv('SYNC_MAX_CONCURRENCY', 0, 0),
  // 文字水印、字幕用的字体。FONT_NAME 是 fontconfig 字体名（Docker 镜像里设为 Noto Sans CJK SC），FONT_FILE 是字体文件路径，
  // 设置了 FONT_FILE 时水印和烧录字幕都用它。.ttc 字体集：水印（drawtext）只能取其中第 0 个字体，
  // 字幕可以用 FONT_NAME 写其中某个字体的族名来挑选。镜像自带的 Noto CJK 只有 .ttc、第 0 个是日文字形，所以镜像里只设 FONT_NAME。
  // 都不设时 Linux 用 fontconfig 默认字体，Windows 退回系统里的微软雅黑（见 src/utils/fonts.ts）
  fontFile: process.env.FONT_FILE ?? '',
  fontName: process.env.FONT_NAME ?? '',
  // S3 兼容对象存储（AWS S3、Cloudflare R2、MinIO、阿里云 OSS 等），设置了 S3_BUCKET 才启用
  s3: {
    bucket: process.env.S3_BUCKET ?? '',
    endpoint: trimSlash(process.env.S3_ENDPOINT),
    region: process.env.S3_REGION || 'auto',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    prefix: (process.env.S3_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
    // 设置后产物地址是 `${S3_PUBLIC_BASE_URL}/${key}`，否则返回预签名链接
    publicBaseUrl: trimSlash(process.env.S3_PUBLIC_BASE_URL),
    // SigV4 预签名最长 7 天
    presignExpiresSeconds: Math.min(
      intEnv('S3_PRESIGN_EXPIRES_SECONDS', 7 * 24 * 60 * 60, 60),
      7 * 24 * 60 * 60,
    ),
    // 上传成功后默认删除本地副本
    keepLocalCopy: process.env.S3_KEEP_LOCAL_COPY === 'true',
  },
};
