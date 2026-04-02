import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { ffmpegService } from '../services/ffmpeg.service';

const router = Router();

router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传文件' });
      return;
    }
    const info = await ffmpegService.getInfo(req.file.path);
    res.json({ success: true, data: info });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
