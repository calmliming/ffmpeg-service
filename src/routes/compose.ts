import { Router, Request, Response } from 'express';
import { ffmpegService } from '../services/ffmpeg.service';
import { taskService } from '../services/task.service';

const router = Router();

/**
 * POST /api/compose
 * 合成视频：多个在线视频 URL 拼接 + 可选背景音乐
 * Body (JSON):
 *   videos: string[]  - 视频 URL 列表
 *   music?: string    - 背景音乐 URL
 *   musicVolume?: number - 音乐音量 0-1
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { videos, music, musicVolume } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      res.status(400).json({ success: false, error: '请提供 videos 数组（在线视频 URL 列表）' });
      return;
    }

    const task = taskService.create('compose');
    res.json({ success: true, data: { taskId: task.id, status: task.status } });

    ffmpegService.compose(task.id, {
      videos,
      music,
      musicVolume: musicVolume ? Number(musicVolume) : undefined,
    }).catch(() => {});
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
