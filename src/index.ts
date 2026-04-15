import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { errorHandler } from './middleware/error';
import { taskService } from './services/task.service';
import './services/queue.service'; // 启动 BullMQ Worker
import healthRouter from './routes/health';
import infoRouter from './routes/info';
import transcodeRouter from './routes/transcode';
import editRouter from './routes/edit';
import processRouter from './routes/process';
import composeRouter from './routes/compose';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// 静态文件服务 - 输出文件下载
app.use('/api/files', (req, res, next) => {
  if (!config.saveOutputFile) {
    // 确保文件完全发送后再删除
    res.on('finish', () => {
      if (res.statusCode === 200) {
        const filePath = path.join(config.outputDir, req.path);
        fs.unlink(filePath, () => {});
      }
    });
  }
  next();
}, express.static(config.outputDir));

// 路由
app.use('/api/health', healthRouter);
app.use('/api/info', infoRouter);
app.use('/api/transcode', transcodeRouter);
app.use('/api/edit', editRouter);
app.use('/api/process', processRouter);
app.use('/api/compose', composeRouter);

// 任务查询
app.get('/api/tasks/:id', (req, res) => {
  const task = taskService.get(req.params.id);
  if (!task) {
    res.status(404).json({ success: false, error: '任务不存在' });
    return;
  }

  const data: any = { ...task };
  if (task.output) {
    // 将绝对路径转为下载 URL
    data.downloadUrl = task.output
      .split(',')
      .map(f => `/api/files/${path.basename(f)}`);
  }
  res.json({ success: true, data });
});

// SSE 进度推送
app.get('/api/tasks/:id/progress', (req, res) => {
  const task = taskService.get(req.params.id);
  if (!task) {
    res.status(404).json({ success: false, error: '任务不存在' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 如果任务已经是终态，直接发送最终状态并关闭
  if (task.status === 'completed' || task.status === 'failed') {
    res.write(`data: ${JSON.stringify(task)}\n\n`);
    res.end();
    return;
  }

  const cleanup = taskService.onProgress(req.params.id, (updated) => {
    res.write(`data: ${JSON.stringify(updated)}\n\n`);
    if (updated.status === 'completed' || updated.status === 'failed') {
      res.end();
    }
  });

  req.on('close', cleanup);
});

// 错误处理
app.use(errorHandler);

const server = app.listen(config.port, () => {
  const { version } = require('../package.json');
  console.log(`FFmpeg Service v${version} 已启动: http://localhost:${config.port}`);
  console.log(`API 文档:`);
  console.log(`  GET  /api/health              - 健康检查`);
  console.log(`  POST /api/info                - 获取媒体信息`);
  console.log(`  POST /api/transcode           - 视频转码`);
  console.log(`  POST /api/edit/trim           - 视频裁剪`);
  console.log(`  POST /api/edit/merge          - 视频拼接`);
  console.log(`  POST /api/edit/extract-audio  - 提取音频`);
  console.log(`  POST /api/process/watermark   - 添加水印`);
  console.log(`  POST /api/process/screenshot  - 视频截图`);
  console.log(`  POST /api/process/thumbnail   - 生成缩略图`);
  console.log(`  POST /api/process/gif         - 视频转GIF`);
  console.log(`  POST /api/compose             - 在线视频合成(+背景音乐)`);
  console.log(`  GET  /api/tasks/:id           - 查询任务状态`);
  console.log(`  GET  /api/tasks/:id/progress  - SSE实时进度`);
});

// 优雅关闭
function shutdown(signal: string) {
  console.log(`\n收到 ${signal} 信号，正在关闭服务...`);
  server.close(() => {
    console.log('HTTP 服务已关闭');
    process.exit(0);
  });
  // 超时强制退出
  setTimeout(() => {
    console.error('关闭超时，强制退出');
    process.exit(1);
  }, 30000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
