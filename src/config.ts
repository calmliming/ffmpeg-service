import path from 'path';
import os from 'os';

export const config = {
  port: Number(process.env.PORT) || 9527,
  uploadDir: path.resolve(__dirname, '../uploads'),
  outputDir: path.resolve(__dirname, '../output'),
  maxFileSize: 500 * 1024 * 1024, // 500MB
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  saveOutputFile: process.env.SAVE_OUTPUT_FILE !== 'false',
  maxConcurrentTasks: Number(process.env.MAX_CONCURRENT_TASKS) || Math.max(1, os.cpus().length - 1),
};
