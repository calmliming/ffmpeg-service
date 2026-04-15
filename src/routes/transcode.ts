import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { jobQueue } from '../services/queue.service';
import { taskService } from '../services/task.service';

const router = Router();

router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传视频文件' });
      return;
    }

    const options = {
      format: req.body.format,
      videoCodec: req.body.videoCodec,
      audioCodec: req.body.audioCodec,
      videoBitrate: req.body.videoBitrate,
      audioBitrate: req.body.audioBitrate,
      resolution: req.body.resolution,
      fps: req.body.fps ? Number(req.body.fps) : undefined,
    };

    const task = taskService.create('transcode');
    task.inputFiles = [req.file.path];
    await jobQueue.add('transcode', { taskId: task.id, type: 'transcode', inputPath: req.file.path, options });
    res.json({ success: true, data: { taskId: task.id, status: task.status } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
