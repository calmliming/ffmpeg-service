import { z } from 'zod';
import { blankToUndefined, httpUrl, toArray, toBoolean, toNumber } from './coerce';

export const composeSchema = z.object({
  videos: z.preprocess(
    toArray,
    z
      .array(httpUrl('请提供有效的视频 URL'), {
        error: (issue) =>
          issue.input === undefined ? '请提供 videos 视频 URL 列表' : 'videos 必须是视频 URL 数组',
      })
      .min(1, '请至少提供1个视频 URL'),
  ),
  music: z.preprocess(blankToUndefined, httpUrl('请提供有效的音乐 URL').optional()),
  musicVolume: z.preprocess(
    toNumber,
    z
      .number({ error: 'musicVolume 必须是 0 到 1 之间的数字' })
      .min(0, 'musicVolume 不能小于 0')
      .max(1, 'musicVolume 不能大于 1')
      .optional(),
  ),
  muteOriginalAudio: z.preprocess(
    toBoolean,
    z.boolean({ error: 'muteOriginalAudio 必须是布尔值' }).optional(),
  ),
});

export type ComposeBody = z.infer<typeof composeSchema>;
