import { Router, type Request, type Response } from 'express';
import { sendServerError } from '../middleware/error';
import { cancelTask, type CancelQueue } from '../services/queue.service';
import { isTerminal, taskView, type TaskService } from '../services/task.service';
import type { Task } from '../types';

/** SSE 心跳间隔：代理和负载均衡常在 30-60 秒无数据时断开连接 */
const HEARTBEAT_MS = 15_000;
const MAX_REASON_LENGTH = 200;

const CONFLICT_MESSAGES: Record<string, string> = {
  completed: '任务已完成，不能取消',
  failed: '任务已失败，不能取消',
  cancelled: '任务已经取消过了',
};

/** 取消原因（可选）：JSON / 表单字段 reason，写进 task.error 和回调 */
function cancelReason(req: Request): string | undefined | { error: string } {
  const body: unknown = req.body;
  const value =
    body && typeof body === 'object' ? (body as Record<string, unknown>).reason : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return { error: 'reason 必须是字符串' };
  const reason = value.trim();
  if (reason.length > MAX_REASON_LENGTH) {
    return { error: `reason 最长 ${MAX_REASON_LENGTH} 个字符` };
  }
  return reason || undefined;
}

export interface TaskRouteDeps {
  queue: CancelQueue;
  /** 取消时查 job、删 job 的超时，默认 QUEUE_COMMAND_TIMEOUT_MS */
  queueTimeoutMs?: number;
}

export function createTaskRouter(tasks: TaskService, deps: TaskRouteDeps): Router {
  const router = Router();

  // 取消任务：POST /:id/cancel 和 DELETE /:id 等价
  const cancel = async (req: Request<{ id: string }>, res: Response) => {
    const reason = cancelReason(req);
    if (typeof reason === 'object') {
      res.status(400).json({ success: false, error: reason.error });
      return;
    }
    let outcome: Awaited<ReturnType<typeof cancelTask>>;
    try {
      outcome = await cancelTask(
        req.params.id,
        { tasks, queue: deps.queue, queueTimeoutMs: deps.queueTimeoutMs },
        reason,
      );
    } catch (err) {
      sendServerError(res, err);
      return;
    }
    if (outcome.kind === 'not-found') {
      res.status(404).json({ success: false, error: '任务不存在' });
      return;
    }
    if (outcome.kind === 'terminal') {
      const { status } = outcome.task;
      res.status(409).json({
        success: false,
        error: CONFLICT_MESSAGES[status] ?? `任务已结束（${status}），不能取消`,
        data: taskView(outcome.task),
      });
      return;
    }
    res.json({ success: true, data: taskView(outcome.task) });
  };
  router.post('/:id/cancel', cancel);
  router.delete('/:id', cancel);

  // 任务查询
  // 读 Redis 出错必须自己兜住，Redis 不可用时返回 503 让客户端重试
  router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
    let task: Task | undefined;
    try {
      task = await tasks.get(req.params.id);
    } catch (err) {
      sendServerError(res, err);
      return;
    }
    if (!task) {
      res.status(404).json({ success: false, error: '任务不存在' });
      return;
    }
    res.json({ success: true, data: taskView(task) });
  });

  // SSE 进度推送
  router.get('/:id/progress', async (req: Request<{ id: string }>, res: Response) => {
    const id = req.params.id;
    // 先订阅再读取：反过来的话，读取和订阅之间完成的任务永远收不到终态，连接一直挂着
    const buffered: Task[] = [];
    let ready = false;
    let closed = false;
    let lastSent = '';
    let heartbeat: NodeJS.Timeout | undefined;

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    const send = (task: Task) => {
      if (closed) return;
      const payload = JSON.stringify(taskView(task));
      if (payload !== lastSent) {
        lastSent = payload;
        res.write(`data: ${payload}\n\n`);
      }
      if (isTerminal(task.status)) {
        // 单独一段只带 id、不带 data：EventSource 只记下 Last-Event-ID，不会多派发一条消息，
        // 按 data: 行解析的客户端也不受影响。断线重连时带着它来，见下面的 204
        res.write(`id: ${task.status}\n\n`);
        close();
      }
    };
    const unsubscribe = tasks.onProgress(id, (task) => {
      if (ready) send(task);
      else buffered.push(task);
    });
    // 只听 res 的 close：没有请求体的 GET 在请求读完时 req 就会发 close，那时客户端还连着
    res.on('close', close);

    let task: Task | undefined;
    try {
      task = await tasks.get(id);
    } catch (err) {
      unsubscribe();
      closed = true;
      sendServerError(res, err);
      return;
    }
    if (!task) {
      unsubscribe();
      closed = true;
      res.status(404).json({ success: false, error: '任务不存在' });
      return;
    }
    if (closed) return;
    // 终态后服务端会关闭连接，而旧版前端示例只在 completed / failed 时 close()：任务被取消后，EventSource
    // 每 3 秒重连一次、拿到同样的终态又被断开，一直循环到记录过期。重连请求带的 Last-Event-ID 就是上面发的终态，
    // 说明客户端已经收到过了，回 204：按 SSE 规范，EventSource 收到 204 就不再重连
    if (isTerminal(task.status) && req.get('last-event-id') === task.status) {
      unsubscribe();
      closed = true;
      res.status(204).end();
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // nginx 默认缓冲代理响应，不关掉的话进度会攒成一批才到客户端
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    ready = true;
    send(task);
    for (const update of buffered) send(update);
    if (closed) return;

    // 心跳顺便从 Redis 补一次状态：任务若由另一个进程的 Worker 执行，本进程收不到它的写入事件
    heartbeat = setInterval(() => {
      tasks
        .get(id)
        .then((latest) => {
          if (closed) return;
          if (!latest) return close();
          send(latest);
          if (!closed) res.write(': ping\n\n');
        })
        .catch(() => {
          if (!closed) res.write(': ping\n\n');
        });
    }, HEARTBEAT_MS);
  });

  return router;
}
