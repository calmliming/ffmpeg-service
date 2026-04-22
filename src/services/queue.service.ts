import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { ffmpegService } from './ffmpeg.service';
import { taskService } from './task.service';

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

export const jobQueue = new Queue('ffmpeg', { connection });

type JobPayload = {
  taskId: string;
  type: string;
  inputPath?: string;
  inputPaths?: string[];
  format?: string;
  options?: any;
};

export const worker = new Worker<JobPayload>(
  'ffmpeg',
  async (job: Job<JobPayload>) => {
    const { type, taskId, inputPath, inputPaths, format, options } = job.data;

    switch (type) {
      case 'transcode':
        return ffmpegService.transcode(inputPath!, taskId, options);
      case 'trim':
        return ffmpegService.trim(inputPath!, taskId, options);
      case 'merge':
        return ffmpegService.merge(inputPaths!, taskId);
      case 'extract-audio':
        return ffmpegService.extractAudio(inputPath!, taskId, format || 'mp3');
      case 'watermark':
        return ffmpegService.watermark(inputPath!, taskId, options);
      case 'screenshot':
        return ffmpegService.screenshot(inputPath!, taskId, options);
      case 'thumbnail':
        return ffmpegService.thumbnail(inputPath!, taskId, options);
      case 'gif':
        return ffmpegService.toGif(inputPath!, taskId, options);
      case 'compose':
        return ffmpegService.compose(taskId, options);
      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  },
  {
    connection,
    concurrency: config.maxConcurrentTasks,
  },
);

// 兜底：Worker 内部未捕获的异常更新任务状态
worker.on('failed', async (job, err) => {
  if (job) {
    const task = await taskService.get(job.data.taskId);
    if (task && task.status !== 'failed') {
      await taskService.update(job.data.taskId, { status: 'failed', error: err.message });
    }
  }
});

worker.on('error', (err) => {
  console.error('[BullMQ Worker Error]', err);
});

console.log(`[BullMQ] Worker started, concurrency=${config.maxConcurrentTasks}`);
