import IORedis, { type RedisOptions } from 'ioredis';
import { config } from '../config';

/** ioredis 断线后每次重连失败都会发 error 事件，不节流的话 Redis 一挂日志就被刷屏 */
export function createRedis(name: string, options: RedisOptions): IORedis {
  // ioredis 6 把默认重连间隔改成指数退避、最长 5 s：断线 30 s 后入队要等满 commandTimeout 才失败，
  // Redis 恢复后健康检查要 3 s 以上才回到 200（2026-10-26 实测）。这里恢复 ioredis 5 的线性 50 ms、上限 2 s。
  const client = new IORedis(config.redisUrl, {
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
    ...options,
  });
  let lastLogged = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLogged < 30_000) return;
    lastLogged = now;
    console.error(`[Redis:${name}] ${err.message}`);
  });
  client.on('ready', () => {
    if (lastLogged) console.log(`[Redis:${name}] 已重新连接`);
    lastLogged = 0;
  });
  return client;
}
