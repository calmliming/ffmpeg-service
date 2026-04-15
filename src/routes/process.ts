import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { jobQueue } from '../services/queue.service';
import { taskService } from '../services/task.service';

const router = Router();

// 添加水印
router.post('/watermark', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 },
]), async (req: Request, res: Response) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const videoFile = files?.file?.[0];
    if (!videoFile) {
      res.status(400).json({ success: false, error: '请上传视频文件' });
      return;
    }

    const watermarkImage = files?.image?.[0];
    const task = taskService.create('watermark');
    task.inputFiles = [videoFile.path, ...(watermarkImage ? [watermarkImage.path] : [])];
    await jobQueue.add('watermark', { taskId: task.id, type: 'watermark', inputPath: videoFile.path, options: {
      text: req.body.text,
      image: watermarkImage?.path,
      position: req.body.position || 'bottom-right',
      fontSize: req.body.fontSize ? Number(req.body.fontSize) : undefined,
      fontColor: req.body.fontColor,
    }});
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 视频截图
router.post('/screenshot', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传视频文件' });
      return;
    }
    const timestamps = req.body.timestamps;
    if (!timestamps) {
      res.status(400).json({ success: false, error: '请提供 timestamps 参数（逗号分隔）' });
      return;
    }

    const task = taskService.create('screenshot');
    task.inputFiles = [req.file.path];
    const timeList = typeof timestamps === 'string' ? timestamps.split(',') : timestamps;
    await jobQueue.add('screenshot', { taskId: task.id, type: 'screenshot', inputPath: req.file.path, options: { timestamps: timeList } });
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 生成缩略图
router.post('/thumbnail', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传视频文件' });
      return;
    }

    const task = taskService.create('thumbnail');
    task.inputFiles = [req.file.path];
    await jobQueue.add('thumbnail', { taskId: task.id, type: 'thumbnail', inputPath: req.file.path, options: {
      count: req.body.count ? Number(req.body.count) : undefined,
      size: req.body.size,
    }});
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 视频转 GIF
router.post('/gif', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传视频文件' });
      return;
    }

    const task = taskService.create('gif');
    task.inputFiles = [req.file.path];
    await jobQueue.add('gif', { taskId: task.id, type: 'gif', inputPath: req.file.path, options: {
      startTime: req.body.startTime,
      duration: req.body.duration ? Number(req.body.duration) : undefined,
      width: req.body.width ? Number(req.body.width) : undefined,
      fps: req.body.fps ? Number(req.body.fps) : undefined,
    }});
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
