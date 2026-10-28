import {
  deliverWebhook as defaultDeliverWebhook,
  type WebhookDeliveryResult,
} from '../services/webhook.service';
import { isTerminal, taskView, type TaskService } from '../services/task.service';
import type { Task, TaskCallback, TerminalStatus } from '../types';

export type DeliverWebhook = typeof defaultDeliverWebhook;

export const WEBHOOK_EVENTS: Record<TerminalStatus, string> = {
  completed: 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.cancelled',
};

export interface WebhookDispatcher {
  /** 不再接收新的终态事件 */
  stop(): void;
  /** 等在途的回调投递完成；超过 timeoutMs 就中止它们 */
  drain(timeoutMs?: number): Promise<void>;
  /** 在途的投递数 */
  readonly pending: number;
}

/**
 * 订阅任务终态事件，向 callbackUrl 投递回调并把结果记到任务上。
 * 挂在 TaskService 的终态事件上而不是 Worker 里：取消接口、兜底的 failed 处理等任何把任务推进到终态的地方
 * 都会触发，且 finish 的原子写入保证每个任务只投递一次。投递不 await，不占 Worker 的并发槽
 */
export function startWebhookDispatcher(
  tasks: TaskService,
  deliver: DeliverWebhook = defaultDeliverWebhook,
): WebhookDispatcher {
  const inflight = new Set<Promise<void>>();
  const controller = new AbortController();

  async function dispatch(task: Task & { callbackUrl: string }): Promise<void> {
    if (!isTerminal(task.status)) return;
    const event = WEBHOOK_EVENTS[task.status];
    let result: WebhookDeliveryResult;
    try {
      result = await deliver(
        task.callbackUrl,
        { event, task: taskView(task) },
        { event, signal: controller.signal },
      );
    } catch (err) {
      // 约定 deliverWebhook 永不抛错，这里只是兜底
      result = { delivered: false, attempts: 0, error: (err as Error).message };
    }
    const callback: TaskCallback = {
      delivered: result.delivered,
      attempts: result.attempts,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.delivered ? { deliveredAt: new Date() } : {}),
      ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}),
    };
    if (result.delivered) {
      console.log(`[Task:${task.id}] 回调已送达（${event}，${result.attempts} 次）`);
    } else {
      console.warn(`[Task:${task.id}] 回调投递失败（${event}）: ${result.error ?? result.status}`);
    }
    try {
      await tasks.recordCallback(task.id, callback);
    } catch (err) {
      console.error(`[Task:${task.id}] 记录回调结果失败: ${(err as Error).message}`);
    }
  }

  const unsubscribe = tasks.onTerminal((task) => {
    if (!task.callbackUrl) return;
    const promise: Promise<void> = dispatch(task as Task & { callbackUrl: string })
      .catch((err: Error) => console.error(`[Task:${task.id}] 回调出错: ${err.message}`))
      .finally(() => inflight.delete(promise));
    inflight.add(promise);
  });

  return {
    stop: unsubscribe,
    get pending() {
      return inflight.size;
    },
    async drain(timeoutMs = 30_000) {
      if (inflight.size === 0) return;
      const timer = setTimeout(
        () => controller.abort(new Error('服务关闭，停止投递回调')),
        timeoutMs,
      );
      try {
        await Promise.allSettled([...inflight]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
