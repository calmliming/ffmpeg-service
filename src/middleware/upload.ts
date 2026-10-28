import fs from 'fs';
import multer from 'multer';
import path from 'path';
import type { Request, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { InputKind, InputSlot } from '../operations/types';
import { HttpError } from './error';

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.flv',
  '.wmv',
  '.ts',
  '.mts',
  '.m2ts',
  '.3gp',
  '.mpg',
  '.mpeg',
  '.ogv',
  '.mxf',
  '.vob',
  '.y4m',
  // 动图按视频处理，GIF 转 MP4 这类需求很常见
  '.gif',
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.aac',
  '.m4a',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wma',
  '.amr',
  '.aif',
  '.aiff',
  '.ac3',
  '.eac3',
  '.mka',
  '.caf',
  '.weba',
  '.mp2',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.apng',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  // AVIF（av1 解码）和 HEIC / HEIF（手机照片，FFmpeg 的 mov 解复用器能读）。
  // curl -F、Go、PHP 默认发 octet-stream，不在这里的扩展名就会被拒
  '.avif',
  '.heic',
  '.heif',
]);

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt']);

export const KIND_LABELS: Record<InputKind, string> = {
  video: '视频',
  audio: '音频',
  image: '图片',
  subtitle: '字幕（srt / ass / ssa / vtt）',
  media: '视频或音频',
  any: '音视频、图片或字幕',
};

function matchesVideo(mime: string, ext: string): boolean {
  return (
    mime.startsWith('video/') ||
    mime === 'image/gif' ||
    mime === 'application/ogg' ||
    VIDEO_EXTENSIONS.has(ext)
  );
}

function matchesAudio(mime: string, ext: string): boolean {
  return mime.startsWith('audio/') || mime === 'application/ogg' || AUDIO_EXTENSIONS.has(ext);
}

function matchesImage(mime: string, ext: string): boolean {
  // SVG 是 XML，FFmpeg 解不了，也不该落到输出目录被当成网页打开
  return (mime.startsWith('image/') && mime !== 'image/svg+xml') || IMAGE_EXTENSIONS.has(ext);
}

function matchesSubtitle(mime: string, ext: string): boolean {
  return (
    mime.startsWith('text/') || mime === 'application/x-subrip' || SUBTITLE_EXTENSIONS.has(ext)
  );
}

/**
 * Go 的 multipart.CreateFormFile、PHP 不指定类型的 CURLFile、curl -F 默认都发
 * application/octet-stream，只认 mimetype 会把这些客户端全部拒掉，所以 MIME 和扩展名任一符合就放行。
 * 文件内容是否真的可用交给后面的 ffprobe / ffmpeg 判断。
 */
export function isAllowedForKind(kind: InputKind, mimetype: string, originalname: string): boolean {
  const mime = mimetype.trim().toLowerCase();
  const ext = path.extname(originalname).toLowerCase();
  switch (kind) {
    case 'video':
      return matchesVideo(mime, ext);
    case 'audio':
      return matchesAudio(mime, ext);
    case 'image':
      return matchesImage(mime, ext);
    case 'subtitle':
      return matchesSubtitle(mime, ext);
    case 'media':
      return matchesVideo(mime, ext) || matchesAudio(mime, ext);
    case 'any':
      return (
        matchesVideo(mime, ext) ||
        matchesAudio(mime, ext) ||
        matchesImage(mime, ext) ||
        matchesSubtitle(mime, ext)
      );
  }
}

/** 旧接口的判断：音视频或图片（不含字幕） */
export function isAllowedUpload(mimetype: string, originalname: string): boolean {
  return (
    isAllowedForKind('media', mimetype, originalname) ||
    isAllowedForKind('image', mimetype, originalname)
  );
}

/**
 * multer 为每个请求在上传目录里创建过的文件（含还在写入的）。客户端中途断开时，正在写的文件在 req.files 里
 * 只是一个没有 path 的占位对象（multer 2 的 insertPlaceholder），只看 req.files 找不到这个半截文件
 */
const createdUploads = new WeakMap<Request, Set<string>>();

/** 本次请求落盘（或正在落盘）的上传文件路径，去重 */
export function uploadedFilePaths(req: Request): string[] {
  const paths = new Set<string>(createdUploads.get(req));
  // 占位对象没有 path，跳过
  const add = (file: { path?: unknown }) => {
    if (typeof file.path === 'string' && file.path) paths.add(file.path);
  };
  if (req.file) add(req.file);
  if (Array.isArray(req.files)) {
    req.files.forEach(add);
  } else if (req.files) {
    for (const list of Object.values(req.files)) list.forEach(add);
  }
  return [...paths];
}

/**
 * 删掉本次请求的上传文件，包括写到一半的。会在 res 的 close 监听器里调用，
 * 这里抛出的异常没有任何地方接住，会直接带崩整个进程（连同在跑的任务），所以绝不能抛
 */
export function removeUploadedFiles(req: Request): void {
  try {
    for (const file of uploadedFilePaths(req)) fs.unlink(file, () => {});
  } catch (err) {
    console.warn(`[Upload] 清理上传文件失败: ${(err as Error).message}`);
  }
}

/** 按槽名分组的上传文件（multer .fields() 的结果） */
export function uploadedFilesBySlot(req: Request): Record<string, Express.Multer.File[]> {
  if (!req.files || Array.isArray(req.files)) return {};
  return req.files;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.uploadDir);
  },
  filename: (req, file, cb) => {
    // 扩展名留给 FFmpeg 判断格式用；只保留短的字母数字，Windows 不允许的字符和超长扩展名都丢掉
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${uuidv4()}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`;
    // 在 multer 打开文件之前记下来，请求中途断开时才删得到半截文件
    const created = createdUploads.get(req) ?? new Set<string>();
    created.add(path.join(config.uploadDir, name));
    createdUploads.set(req, created);
    cb(null, name);
  },
});

/** 表单里文本字段的基础上限：本服务的表单最多十来个短字段 */
const BASE_FIELDS = 50;

/**
 * 按操作的输入槽生成 multer 中间件：每个槽一个文件字段，maxCount 为 multiple.max（单文件槽为 1），
 * 文件类型按槽的 InputKind 过滤。不是 multipart 的请求（JSON、urlencoded）multer 直接放行
 */
export function createUploadMiddleware(slots: readonly InputSlot[]): RequestHandler {
  const bySlot = new Map(slots.map((slot) => [slot.name, slot]));
  const maxFiles = slots.reduce((sum, slot) => sum + (slot.multiple?.max ?? 1), 0);
  // 多文件槽也能用同名文本字段重复提交多个链接（如 videos=…&videos=…），字段上限要放宽到能装下
  const urlFields = slots.reduce((sum, slot) => sum + (slot.multiple ? slot.multiple.max : 0), 0);
  const fields = BASE_FIELDS + urlFields;

  // multer 2 拒绝上传时要等客户端把整个请求体传完才回复 400（multer 1 是立刻回复）。这是有意的：
  // 先发完请求体再读响应的客户端因此一定能拿到 400。不要在 fileFilter 里提前写响应——
  // 2026-10-27 在 Node 26 上实测，提前回复后服务端不再读取剩余请求体，客户端写入卡住，
  // 约 6 秒后连接被 keep-alive 超时关闭，multer 迟到的 next(err) 也不会触发。
  const instance = multer({
    storage,
    limits: {
      fileSize: config.maxFileSize,
      // 比各槽上限之和多 1：多出来的那个文件一定是字段名不对或超过了某个槽的上限，交给下面按槽说明的
      // LIMIT_UNEXPECTED_FILE。等于上限之和的话 busboy 的总数限制先触发，只能报笼统的「文件数量超过上限」
      files: maxFiles + 1,
      // multer 2 的以下各项默认都是 Infinity：x[1e8]、多层嵌套字段名能长时间阻塞事件循环
      // （CVE-2026-82333、CVE-2026-5079），大量 1 MB 文本字段能把 2 GB 内存的容器撑到 OOM。
      // 本服务的表单最多十来个短字段，字段名最多一层数组，如 timestamps[]
      fieldNestingDepth: 1,
      fieldArrayIndexLimit: 100,
      fields,
      fieldSize: 64 * 1024,
      parts: fields + maxFiles + 10,
    },
    fileFilter: (_req, file, cb) => {
      const slot = bySlot.get(file.fieldname);
      if (slot && isAllowedForKind(slot.kind, file.mimetype, file.originalname)) {
        return cb(null, true);
      }
      const accepted = slot ? `，${slot.name} 只接受${KIND_LABELS[slot.kind]}文件` : '';
      cb(
        new HttpError(400, `不支持的文件类型: ${file.mimetype}（${file.originalname}）${accepted}`),
      );
    },
  });
  const handler = instance.fields(
    slots.map((slot) => ({ name: slot.name, maxCount: slot.multiple?.max ?? 1 })),
  );

  const accepted = slots.length
    ? slots.map((s) => `${s.name}（最多 ${s.multiple?.max ?? 1} 个）`).join('、')
    : '无';
  return (req, res, next) => {
    handler(req, res, (err?: unknown) => {
      // 字段名不对和同一字段文件过多 multer 报的是同一个错误，这里按本接口的槽说清楚
      if (err instanceof multer.MulterError && err.code === 'LIMIT_UNEXPECTED_FILE') {
        const slot = err.field ? bySlot.get(err.field) : undefined;
        const message = slot
          ? `${slot.name} 最多上传 ${slot.multiple?.max ?? 1} 个文件`
          : `不接受文件字段 ${err.field ?? ''}，本接口的文件字段: ${accepted}`;
        return next(new HttpError(400, `上传参数错误: ${message}`));
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') {
        return next(
          new HttpError(400, `上传参数错误: 上传的文件数量超过上限，本接口的文件字段: ${accepted}`),
        );
      }
      next(err);
    });
  };
}
