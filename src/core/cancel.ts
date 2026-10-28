/**
 * 取消广播：BullMQ 的 worker.cancelJob 只能中止本进程里在跑的 job，多实例部署时执行任务的可能是另一台机器。
 * 取消接口把 { jobId, reason } 发到 Redis 频道，每个 Worker 用专用的订阅连接收听，谁在跑这个 job 谁中止。
 * Redis 的 pub/sub 不保证送达（订阅连接正在重连时消息就丢了），Worker 另外会定时查任务状态兜底
 */

/** 频道名跟着 BullMQ 的 key 前缀走（<prefix>:<queue>:cancel），测试用不同前缀时互不干扰 */
export function cancelChannel(qualifiedName: string): string {
  return `${qualifiedName}:cancel`;
}

export interface CancelMessage {
  jobId: string;
  reason: string;
}

export interface Publisher {
  publish(channel: string, message: string): Promise<number>;
}

/** 返回收到消息的订阅者数（0 表示没有 Worker 在听，任务状态已经写成 cancelled，Worker 的定时检查会补上） */
export function publishCancel(
  publisher: Publisher,
  channel: string,
  message: CancelMessage,
): Promise<number> {
  return publisher.publish(channel, JSON.stringify(message));
}

export function parseCancelMessage(raw: string): CancelMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const { jobId, reason } = value as Record<string, unknown>;
    if (typeof jobId !== 'string' || !jobId) return undefined;
    return { jobId, reason: typeof reason === 'string' ? reason : '' };
  } catch {
    return undefined;
  }
}

export interface Subscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

/** 订阅取消频道。返回的 Promise 在订阅生效后完成；断线重连后 ioredis 会自动重新订阅 */
export function subscribeCancels(
  subscriber: Subscriber,
  channel: string,
  onCancel: (message: CancelMessage) => void,
): Promise<unknown> {
  subscriber.on('message', (from, raw) => {
    if (from !== channel) return;
    const message = parseCancelMessage(raw);
    if (message) onCancel(message);
  });
  return subscriber.subscribe(channel);
}
