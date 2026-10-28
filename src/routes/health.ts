import { execFile } from 'child_process';
import fs from 'fs';
import { Router, Request, Response } from 'express';
import { version } from '../../package.json';
import { config } from '../config';
import { checkStorage, storageDriver } from '../services/storage.service';

// 真正执行一次配置的二进制。原来只看 fluent-ffmpeg 能不能找到 ffprobe，
// FFMPEG_PATH 配错时健康检查照样报 available，任务却全部 spawn ENOENT
function binaryWorks(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, ['-version'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
  });
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface HealthDeps {
  /** Redis 是否可用 */
  ping(): Promise<boolean>;
  /** 已注册的操作数 */
  operationCount: number;
  /** 队列里各状态的 job 数（BullMQ getJobCounts，需含 waiting、prioritized、active、delayed、failed） */
  jobCounts(): Promise<Record<string, number>>;
  /** 执行一次二进制（-version）看能不能用，默认 execFile。测试可以替换 */
  checkBinary?: (file: string) => Promise<boolean>;
  /** 存储是否可用（目录可写、S3 存储桶可访问），默认 storageWorks。测试可以替换 */
  checkStorage?: () => Promise<StorageHealth>;
}

export interface StorageHealth {
  ok: boolean;
  error?: string;
}

/**
 * 上传目录和输出目录必须可写（S3 模式下产物也先写在本地）；S3 模式再对存储桶发一次 HeadBucket。
 * 换成非 root 镜像后，旧的数据卷如果还属于 root，所有任务都会 Permission denied，健康检查要能反映出来
 */
async function storageWorks(): Promise<StorageHealth> {
  const dirs: [string, string][] = [
    [config.uploadDir, '上传目录'],
    [config.outputDir, '输出目录'],
  ];
  for (const [dir, label] of dirs) {
    try {
      await fs.promises.access(dir, fs.constants.W_OK);
    } catch (err) {
      // 只给错误码：健康检查不鉴权，errno 消息里带服务器上的绝对路径
      return {
        ok: false,
        error: `${label}不可写（${(err as NodeJS.ErrnoException).code ?? '未知错误'}）`,
      };
    }
  }
  if (storageDriver() === 's3') {
    const result = await checkStorage({ timeoutMs: 5000 });
    if (!result.ok) return { ok: false, error: result.error ?? '对象存储不可用' };
  }
  return { ok: true };
}

const COUNTS_TIMEOUT_MS = 2000;
/** 二进制检查结果的有效期。成功的结果缓存久一些；失败的很快重查，修好配置后不用等太久 */
const BINARY_OK_TTL_MS = 30_000;
const BINARY_FAIL_TTL_MS = 5_000;

/**
 * 健康检查不鉴权（负载均衡探活用），每次请求都 spawn ffmpeg 和 ffprobe 的话，任何能访问端口的人都能让
 * 服务器按请求速率创建进程。结果按路径缓存，并发的请求共用同一次在途检查
 */
function cachedBinaryCheck(check: (file: string) => Promise<boolean>) {
  const cache = new Map<string, { ok: boolean; at: number }>();
  const inflight = new Map<string, Promise<boolean>>();
  return (file: string): Promise<boolean> => {
    const hit = cache.get(file);
    if (hit && Date.now() - hit.at < (hit.ok ? BINARY_OK_TTL_MS : BINARY_FAIL_TTL_MS)) {
      return Promise.resolve(hit.ok);
    }
    const running = inflight.get(file);
    if (running) return running;
    const pending = check(file)
      .catch(() => false)
      .then((ok) => {
        cache.set(file, { ok, at: Date.now() });
        return ok;
      })
      .finally(() => inflight.delete(file));
    inflight.set(file, pending);
    return pending;
  };
}

/** 队列计数只是附带信息：Redis 刚恢复或很慢时不能拖住探活，超时就返回 null */
async function queueCounts(deps: HealthDeps): Promise<QueueCounts | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const counts = await Promise.race([
      deps.jobCounts(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), COUNTS_TIMEOUT_MS);
      }),
    ]);
    return {
      // 带优先级的 job 在 BullMQ 里单独计数，对调用方来说都是在排队
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Redis 挂掉时所有任务接口都不可用，健康检查必须反映出来，不能只看进程活着
export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  const checkBinary = cachedBinaryCheck(deps.checkBinary ?? binaryWorks);
  // 存储检查同样缓存（S3 模式会访问对象存储），复用按 key 缓存的逻辑
  const storageCheck = deps.checkStorage ?? storageWorks;
  let storageResult: StorageHealth = { ok: true };
  const checkStorageCached = cachedBinaryCheck(async () => {
    storageResult = await storageCheck().catch((err: Error) => ({ ok: false, error: err.message }));
    return storageResult.ok;
  });
  router.get('/', async (_req: Request, res: Response) => {
    // Redis 和队列计数每次都查（便宜，而且要反映实时状态）
    const [ffmpegOk, ffprobeOk, redisAvailable, storageOk] = await Promise.all([
      checkBinary(config.ffmpegPath),
      checkBinary(config.ffprobePath),
      deps.ping(),
      checkStorageCached('storage'),
    ]);
    const queue = redisAvailable ? await queueCounts(deps) : null;
    const ffmpegAvailable = ffmpegOk && ffprobeOk;
    const healthy = ffmpegAvailable && redisAvailable && storageOk;
    const missing = [
      !ffmpegOk && `ffmpeg (${config.ffmpegPath})`,
      !ffprobeOk && `ffprobe (${config.ffprobePath})`,
      !redisAvailable && 'redis',
      !storageOk && `存储（${storageResult.error ?? '不可用'}）`,
    ].filter(Boolean);

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      ...(healthy ? {} : { error: `依赖不可用: ${missing.join(', ')}` }),
      data: {
        service: 'ffmpeg-service',
        version,
        status: healthy ? 'running' : 'degraded',
        ffmpeg: ffmpegAvailable ? 'available' : 'not found',
        redis: redisAvailable ? 'available' : 'unavailable',
        storage: storageDriver(),
        storageStatus: storageOk ? 'available' : 'unavailable',
        operations: deps.operationCount,
        queue,
        auth: { enabled: config.apiKeys.length > 0, protectFiles: config.protectFiles },
        timestamp: new Date().toISOString(),
      },
    });
  });
  return router;
}
