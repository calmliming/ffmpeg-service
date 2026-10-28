import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { defineOperation } from '../types';
import { HttpError } from '../../middleware/error';
import { probeRaw } from '../../utils/media-probe';

type Section = Record<string, unknown>;

// fluent-ffmpeg 解析 ffprobe 默认输出时，把形如 123 / 1.5 的字符串转成数字（负数、分数、TAG 不转），沿用同样的规则
const NUMERIC = /^[0-9]+(\.[0-9]+)?$/;

const legacyValue = (value: unknown) =>
  typeof value === 'string' && NUMERIC.test(value) ? Number(value) : value;

function convertSection(section: Section): Section {
  const result: Section = {};
  for (const [key, value] of Object.entries(section)) {
    // tags 保持字符串（与旧版一致）；disposition 本来就是数字
    result[key] = key === 'tags' || key === 'disposition' ? value : legacyValue(value);
  }
  return result;
}

/**
 * 旧版用 ffprobe 的默认文本输出，side_data 块里的字段（rotation、side_data_type…）被摊平到了流上，
 * 客户端可能直接读 stream.rotation；JSON 输出放在 side_data_list 里。两种都给，已有字段不覆盖
 */
function flattenSideData(stream: Section): Section {
  const list = stream.side_data_list;
  if (!Array.isArray(list)) return stream;
  const result = { ...stream };
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item as Section)) {
      if (key in result || (typeof value === 'object' && value !== null)) continue;
      // 旧版是从文本解析的，负数仍是字符串（rotation: "-90"）
      result[key] = legacyValue(String(value));
    }
  }
  return result;
}

const asSections = (value: unknown): Section[] =>
  Array.isArray(value)
    ? value.filter((v): v is Section => Boolean(v) && typeof v === 'object')
    : [];

/** 把 ffprobe 的 JSON 输出换算成旧版 fluent-ffmpeg ffprobe 的形状：{ streams, format, chapters } */
export function toLegacyProbe(raw: Section): {
  streams: Section[];
  format: Section;
  chapters: Section[];
} {
  const format =
    raw.format && typeof raw.format === 'object' ? convertSection(raw.format as Section) : {};
  // 不对外暴露服务器上的临时文件路径，只保留文件名
  if (typeof format.filename === 'string') format.filename = path.basename(format.filename);
  return {
    streams: asSections(raw.streams).map((s) => flattenSideData(convertSection(s))),
    format,
    chapters: asSections(raw.chapters).map(convertSection),
  };
}

export const info = defineOperation({
  name: 'info',
  route: '/api/info',
  title: '获取媒体信息',
  description:
    '同步返回音视频文件的元信息：时长、分辨率、编码、码率、帧率、声道、标签、章节等（ffprobe 结果）。',
  inputs: [{ name: 'file', kind: 'any', required: true, description: '音视频、图片或字幕文件' }],
  params: z.object({}),
  sync: true,
  example: [
    'curl -X POST http://localhost:9527/api/info -F "file=@video.mp4"',
    '',
    '# 用 URL 提交',
    'curl -X POST http://localhost:9527/api/info -H "Content-Type: application/json" \\',
    '  -d \'{"url":"https://example.com/video.mp4"}\'',
  ].join('\n'),
  notes: [
    '同步接口，直接在响应的 data 里返回 { streams, format, chapters }，不创建任务。文件为空或无法解析（不是音视频、已损坏）时返回 422，错误信息不含服务器路径。',
    '与旧版（fluent-ffmpeg）保持同样的形状和数值转换：duration、bit_rate、size、sample_rate、nb_frames 这类非负数字字符串转成数字；r_frame_rate（"25/1"）、负数（start_time 为 -0.02 时）和 tags 里的值保持字符串。',
    '与旧版的差异：值为 N/A 或 unknown 的字段（如 max_bit_rate、color_space）不再出现；chapters 现在真实返回章节（旧版恒为空数组）；side_data_list 原样保留，其中的 rotation 等字段同时摊平到流上（旧版只有摊平的）；format.filename 只返回文件名，不再暴露服务器路径。',
  ],

  async run(ctx) {
    const file = ctx.inputs.file[0];
    // 解析不了是客户端给的文件有问题，返回 422 而不是 500（500 会让客户端以为是服务故障而重试）
    const size = await fs.promises.stat(file).then((s) => s.size);
    if (size === 0) throw new HttpError(422, '文件是空的（0 字节），无法解析');
    let raw: Section;
    try {
      raw = await probeRaw(file, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      // ffprobe 没能启动（没装、没权限、进程数满）是服务端的问题，保持 500
      if (/^spawn .+ E[A-Z]+$/.test(detail) || err instanceof SyntaxError) {
        throw new Error(`无法运行 ffprobe: ${detail}`);
      }
      throw new HttpError(422, `无法解析文件，可能不是有效的媒体文件: ${detail}`);
    }
    return { files: [], data: toLegacyProbe(raw) };
  },
});
