import { Task } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import fs from 'fs';
import { config } from '../config';

/** 已完成任务保留时长（毫秒），默认 1 小时 */
const TASK_TTL = 60 * 60 * 1000;
/** 清理检查间隔（毫秒），默认 10 分钟 */
const CLEANUP_INTERVAL = 10 * 60 * 1000;

class TaskService {
  private tasks = new Map<string, Task>();
  private emitter = new EventEmitter();
  private runningCount = 0;
  private queue: Array<() => void> = [];

  constructor() {
    // 定时清理已完成/失败的过期任务
    setInterval(() => this.cleanup(), CLEANUP_INTERVAL).unref();
  }

  create(type: string): Task {
    const task: Task = {
      id: uuidv4(),
      status: 'pending',
      progress: 0,
      type,
      createdAt: new Date(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, updates: Partial<Pick<Task, 'status' | 'progress' | 'output' | 'error'>>) {
    const task = this.tasks.get(id);
    if (!task) return;
    Object.assign(task, updates);
    if (updates.status === 'completed' || updates.status === 'failed') {
      task.completedAt = new Date();
      // 清理上传的临时文件
      if (task.inputFiles) {
        for (const f of task.inputFiles) {
          fs.unlink(f, () => {});
        }
      }
      // 释放并发槽位，执行队列中的下一个任务
      this.runningCount--;
      this.dequeue();
    }
    this.emitter.emit(`task:${id}`, task);
  }

  /**
   * 并发控制：获取执行槽位
   * 如果当前并发数未满，立即执行；否则排队等待
   */
  acquire(): Promise<void> {
    if (this.runningCount < config.maxConcurrentTasks) {
      this.runningCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.runningCount++;
        resolve();
      });
    });
  }

  onProgress(id: string, listener: (task: Task) => void) {
    this.emitter.on(`task:${id}`, listener);
    return () => this.emitter.removeListener(`task:${id}`, listener);
  }

  private dequeue() {
    if (this.queue.length > 0 && this.runningCount < config.maxConcurrentTasks) {
      const next = this.queue.shift()!;
      next();
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.completedAt && now - task.completedAt.getTime() > TASK_TTL) {
        this.tasks.delete(id);
        this.emitter.removeAllListeners(`task:${id}`);
      }
    }
  }
}

export const taskService = new TaskService();
