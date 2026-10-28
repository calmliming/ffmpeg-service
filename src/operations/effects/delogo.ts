import { z } from 'zod';
import { booleanParam, enumParam, numberParam, timeParam } from '../../schemas/coerce';
import { defineOperation } from '../types';
import {
  VIDEO_INPUT,
  assertFrameSize,
  assertStartInside,
  checkTimeWindow,
  enableExpr,
  filterChainArgs,
  inspectVideo,
  regionsParam,
  toPixels,
  withEnable,
  type Region,
} from './shared';

const coord = (name: string, description: string) =>
  numberParam(name, { min: 0, max: 100000 }).optional().meta({ description });
const size = (name: string, description: string) =>
  numberParam(name, { min: 0.01, max: 100000 }).optional().meta({ description });

/**
 * delogo 用矩形外一圈像素插值填充，矩形必须严格在画面内（至少离每条边 1 像素），
 * 否则直接报 "Logo area is outside of the frame"。这里先夹紧再交给 FFmpeg
 */
export function clampDelogo(r: Region, width: number, height: number, label: string) {
  const x1 = Math.max(1, Math.round(r.x));
  const y1 = Math.max(1, Math.round(r.y));
  const x2 = Math.min(width - 1, Math.round(r.x + r.width));
  const y2 = Math.min(height - 1, Math.round(r.y + r.height));
  if (x2 - x1 < 1 || y2 - y1 < 1) {
    throw new Error(`${label}在画面（${width}x${height}）之外，或只覆盖了最外圈 1 像素的边框`);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

const params = z.object({
  x: coord('x', '水印区域左上角的横坐标'),
  y: coord('y', '水印区域左上角的纵坐标'),
  width: size('width', '水印区域的宽度'),
  height: size('height', '水印区域的高度'),
  regions: regionsParam('regions')
    .optional()
    .meta({
      description:
        '多个水印区域（最多 10 个），代替 x / y / width / height。写法同 /api/video/blur 的 regions，' +
        '对象形式可以带各自的 startTime / endTime（适合位置会跳动的水印）',
    }),
  unit: enumParam('unit', ['px', 'percent'] as const)
    .default('px')
    .meta({ description: '坐标单位：px 像素（默认）或 percent（相对画面宽高的百分比 0-100）' }),
  startTime: timeParam('startTime')
    .optional()
    .meta({ description: '从第几秒开始去水印，秒数或 HH:MM:SS；不传则从头开始' }),
  endTime: timeParam('endTime')
    .optional()
    .meta({ description: '去水印到第几秒，秒数或 HH:MM:SS；不传则到结尾' }),
  show: booleanParam('show')
    .default(false)
    .meta({ description: '调试用：在处理区域画出绿色边框，方便确认坐标，默认 false' }),
});

export const delogo = defineOperation({
  name: 'video.delogo',
  route: '/api/video/delogo',
  title: '去水印',
  description: '用周围像素插值抹掉视频中固定位置的台标、水印或文字，支持多个区域和按时间段处理。',
  inputs: VIDEO_INPUT,
  params,
  chainable: true,
  example: [
    'curl -X POST http://localhost:9527/api/video/delogo \\',
    '  -F "file=@input.mp4" \\',
    '  -F "x=20" -F "y=20" -F "width=180" -F "height=60"',
    '',
    '# 水印中途换位置：两个区域各自带时间段',
    'curl -X POST http://localhost:9527/api/video/delogo \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/input.mp4","regions":[{"x":10,"y":10,"width":200,"height":60,"endTime":5},{"x":500,"y":900,"width":200,"height":60,"startTime":5}]}\'',
  ].join('\n'),
  notes: [
    '用 x / y / width / height 指定一个区域，或用 regions 指定最多 10 个区域，二者选一。',
    'FFmpeg 的 delogo 要求区域严格在画面内：贴边或超出画面的区域会自动收进 1 像素（最外圈 1 像素无法处理），完全在画面外时返回错误。',
    '坐标按旋转后的显示方向计算；不确定坐标时先加 show=true 跑一次，看绿框是否罩住水印。',
    '适合静态的小面积水印，大面积或动态水印抹除后会留下明显的模糊块，这种情况可以改用 /api/video/blur。',
    '画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。',
  ],
  check(p) {
    const single = [p.x, p.y, p.width, p.height];
    const given = single.filter((v) => v !== undefined).length;
    if (p.regions && given > 0) return 'regions 和 x / y / width / height 只能二选一';
    if (!p.regions && given < 4) return '需要同时提供 x、y、width、height，或者用 regions 指定区域';
    return checkTimeWindow(p.startTime, p.endTime);
  },
  async run(ctx, p) {
    const input = await inspectVideo(ctx, ctx.inputs.file[0]);
    assertFrameSize(input);
    const { width: W, height: H } = input;
    const list: Region[] = p.regions ?? [
      { x: p.x ?? 0, y: p.y ?? 0, width: p.width ?? 0, height: p.height ?? 0 },
    ];

    const filters = ['format=yuv420p'];
    list.forEach((region, i) => {
      const label = p.regions ? `regions 第 ${i + 1} 个区域` : '水印区域';
      const box = clampDelogo(toPixels(region, p.unit, W, H), W, H, label);
      const start = region.startTime ?? p.startTime;
      const end = region.endTime ?? p.endTime;
      if (start !== undefined && end !== undefined && end <= start) {
        throw new Error(`${label}的 endTime 必须大于 startTime`);
      }
      assertStartInside(start, input.duration, `${label}的开始时间`);
      const show = p.show ? ':show=1' : '';
      filters.push(
        withEnable(
          `delogo=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}${show}`,
          enableExpr(start, end),
        ),
      );
    });

    const output = ctx.outputPath('mp4');
    await ctx.ffmpeg(filterChainArgs(input, filters, output), { duration: input.duration });
    return { files: [output] };
  },
});
