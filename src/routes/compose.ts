import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { ffmpegService } from '../services/ffmpeg.service';
import { taskService } from '../services/task.service';

const router = Router();

const composeSchema = z.object({
  videos: z.array(z.string().url('请提供有效的视频 URL')).min(1, '请至少提供1个视频 URL'),
  music: z.string().url('请提供有效的音乐 URL').optional(),
  musicVolume: z.number().min(0).max(1).optional(),
});

/**
 * POST /api/compose
 * 合成视频：多个在线视频 URL 拼接 + 可选背景音乐
 */
router.post('/', validate(composeSchema), async (req: Request, res: Response) => {
  try {
    const { videos, music, musicVolume } = req.body;

    const task = taskService.create('compose');
    res.json({ success: true, data: { taskId: task.id, status: task.status } });

    ffmpegService.compose(task.id, {
      videos,
      music,
      musicVolume,
    }).catch(() => {});
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
