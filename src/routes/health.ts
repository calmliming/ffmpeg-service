import { Router, Request, Response } from 'express';
import ffmpeg from 'fluent-ffmpeg';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  ffmpeg.ffprobe('', (err) => {
    // We just check if ffprobe binary exists, not if input is valid
    const ffmpegAvailable = !err?.message?.includes('Cannot find ffprobe');

    res.json({
      success: true,
      data: {
        service: 'ffmpeg-service',
        status: 'running',
        ffmpeg: ffmpegAvailable ? 'available' : 'not found',
        timestamp: new Date().toISOString(),
      },
    });
  });
});

export default router;
