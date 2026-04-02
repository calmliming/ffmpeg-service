import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { ffmpegService } from '../services/ffmpeg.service';
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
    res.json({ success: true, data: { taskId: task.id, status: task.status } });

    ffmpegService.watermark(videoFile.path, task.id, {
      text: req.body.text,
      image: watermarkImage?.path,
      position: req.body.position || 'bottom-right',
      fontSize: req.body.fontSize ? Number(req.body.fontSize) : undefined,
      fontColor: req.body.fontColor,
    }).catch(() => {});
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
    res.json({ success: true, data: { taskId: task.id, status: task.status } });

    const timeList = typeof timestamps === 'string' ? timestamps.split(',') : timestamps;
    ffmpegService.screenshot(req.file.path, task.id, { timestamps: timeList }).catch(() => {});
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
    res.json({ success: true, data: { taskId: task.id, status: task.status } });

    ffmpegService.thumbnail(req.file.path, task.id, {
      count: req.body.count ? Number(req.body.count) : undefined,
      size: req.body.size,
    }).catch(() => {});
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
    res.json({ success: true, data: { taskId: task.id, status: task.status } });

    ffmpegService.toGif(req.file.path, task.id, {
      startTime: req.body.startTime,
      duration: req.body.duration ? Number(req.body.duration) : undefined,
      width: req.body.width ? Number(req.body.width) : undefined,
      fps: req.body.fps ? Number(req.body.fps) : undefined,
    }).catch(() => {});
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
