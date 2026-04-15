import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { jobQueue } from '../services/queue.service';
import { taskService } from '../services/task.service';

const router = Router();

// 视频裁剪
router.post('/trim', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传视频文件' });
      return;
    }
    if (!req.body.startTime) {
      res.status(400).json({ success: false, error: '请提供 startTime 参数' });
      return;
    }

    const task = taskService.create('trim');
    task.inputFiles = [req.file.path];
    await jobQueue.add('trim', { taskId: task.id, type: 'trim', inputPath: req.file.path, options: {
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      duration: req.body.duration ? Number(req.body.duration) : undefined,
    }});
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 视频拼接
router.post('/merge', upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length < 2) {
      res.status(400).json({ success: false, error: '请至少上传2个视频文件' });
      return;
    }

    const task = taskService.create('merge');
    task.inputFiles = files.map(f => f.path);
    await jobQueue.add('merge', { taskId: task.id, type: 'merge', inputPaths: files.map(f => f.path) });
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 提取音频
router.post('/extract-audio', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传视频文件' });
      return;
    }

    const task = taskService.create('extract-audio');
    task.inputFiles = [req.file.path];
    await jobQueue.add('extract-audio', { taskId: task.id, type: 'extract-audio', inputPath: req.file.path, format: req.body.format || 'mp3' });
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
