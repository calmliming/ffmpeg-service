import IORedis from 'ioredis';
import { Task } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import fs from 'fs';
import { config } from '../config';

const TASK_TTL = 60 * 60; // 1小时，单位秒
const key = (id: string) => `task:${id}`;

function serialize(task: Task): string {
  return JSON.stringify(task);
}

function deserialize(raw: string): Task {
  const obj = JSON.parse(raw);
  if (obj.createdAt) obj.createdAt = new Date(obj.createdAt);
  if (obj.startedAt) obj.startedAt = new Date(obj.startedAt);
  if (obj.completedAt) obj.completedAt = new Date(obj.completedAt);
  return obj as Task;
}

class TaskService {
  private redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  async create(type: string, inputFiles?: string[]): Promise<Task> {
    const task: Task = {
      id: uuidv4(),
      status: 'pending',
      progress: 0,
      type,
      createdAt: new Date(),
      ...(inputFiles ? { inputFiles } : {}),
    };
    await this.redis.set(key(task.id), serialize(task), 'EX', TASK_TTL);
    return task;
  }

  async get(id: string): Promise<Task | undefined> {
    const raw = await this.redis.get(key(id));
    return raw ? deserialize(raw) : undefined;
  }

  async update(id: string, updates: Partial<Pick<Task, 'status' | 'progress' | 'output' | 'error' | 'currentVideoIndex' | 'totalVideos' | 'phase'>>): Promise<void> {
    const raw = await this.redis.get(key(id));
    if (!raw) return;
    const task = deserialize(raw);

    if (updates.status === 'processing' && !task.startedAt) {
      task.startedAt = new Date();
    }
    Object.assign(task, updates);

    if (updates.status === 'completed' || updates.status === 'failed') {
      task.completedAt = new Date();
      if (task.inputFiles) {
        for (const f of task.inputFiles) fs.unlink(f, () => {});
      }
    }

    await this.redis.set(key(id), serialize(task), 'EX', TASK_TTL);
    this.emitter.emit(`task:${id}`, task);
  }

  onProgress(id: string, listener: (task: Task) => void) {
    this.emitter.on(`task:${id}`, listener);
    return () => this.emitter.removeListener(`task:${id}`, listener);
  }
}

export const taskService = new TaskService();
