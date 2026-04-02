import { Task, TaskStatus } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

class TaskService {
  private tasks = new Map<string, Task>();
  private emitter = new EventEmitter();

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
    }
    this.emitter.emit(`task:${id}`, task);
  }

  onProgress(id: string, listener: (task: Task) => void) {
    this.emitter.on(`task:${id}`, listener);
    return () => this.emitter.removeListener(`task:${id}`, listener);
  }
}

export const taskService = new TaskService();
