import fs from 'fs';
import path from 'path';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { describeError } from '../utils/download';

export interface StoredOutput {
  /** 本地绝对路径（S3 模式下删除本地副本后文件已不存在） */
  path: string;
  /** 客户端用的下载地址：本地为 /api/files/<相对路径>（配置了 PUBLIC_BASE_URL 时为绝对地址），S3 为公开地址或预签名链接 */
  url: string;
  /** 字节数。S3 预签名模式下改写过引用的播放列表是上传后对象的大小 */
  size: number;
  contentType: string;
  storage: 'local' | 's3';
  /** S3 对象 key */
  key?: string;
}

export type S3Settings = typeof config.s3;

/** 存储用到的全部配置。默认取 config，测试可以整体替换（例如指向临时目录和测试用 MinIO） */
export interface StorageSettings {
  /** 产物根目录，对应 /api/files/ */
  outputRoot: string;
  publicBaseUrl: string;
  s3: S3Settings;
}

export function defaultStorageSettings(): StorageSettings {
  return { outputRoot: config.outputDir, publicBaseUrl: config.publicBaseUrl, s3: config.s3 };
}

export function storageDriver(): 'local' | 's3' {
  return config.s3.bucket ? 's3' : 'local';
}

/** 产物在输出目录里的相对路径（正斜杠），也是 /api/files/ 后面的部分 */
export function relativeOutputPath(file: string, root: string = config.outputDir): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** 每一段分别编码：文件名里的空格、#、? 不会破坏地址，/ 仍然是目录分隔符 */
export function encodeUrlPath(relative: string): string {
  return relative.split('/').map(encodeURIComponent).join('/');
}

/** 本地产物的下载地址。没配 PUBLIC_BASE_URL 时是 /api/files/... 相对地址 */
export function localFileUrl(
  relative: string,
  publicBaseUrl: string = config.publicBaseUrl,
): string {
  return `${publicBaseUrl}/api/files/${encodeUrlPath(relative)}`;
}

/** S3 对象 key：S3_PREFIX 加上产物相对路径 */
export function objectKey(relative: string, prefix: string = config.s3.prefix): string {
  return [prefix, relative].filter(Boolean).join('/');
}

// 只收录本服务会产出的类型。故意不收 svg、html：对象存储按 Content-Type 直接在浏览器里渲染，
// 用户可控内容配上这类类型会变成存储域名下的 XSS
const CONTENT_TYPES: Record<string, string> = {
  // 视频
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  ogv: 'video/ogg',
  wmv: 'video/x-ms-wmv',
  m4s: 'video/iso.segment',
  mxf: 'application/mxf',
  y4m: 'video/x-yuv4mpeg',
  // 音频
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  mka: 'audio/x-matroska',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  ac3: 'audio/ac3',
  eac3: 'audio/eac3',
  amr: 'audio/amr',
  wma: 'audio/x-ms-wma',
  // 图片
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  jxl: 'image/jxl',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // 字幕
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
  lrc: 'text/plain',
  // 播放列表、清单
  m3u8: 'application/vnd.apple.mpegurl',
  m3u: 'audio/x-mpegurl',
  mpd: 'application/dash+xml',
  // 数据
  json: 'application/json',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  zip: 'application/zip',
  pdf: 'application/pdf',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

// 字幕、转写文本多是中文，对象存储不会自己补 charset，浏览器按 Latin-1 打开就是乱码
function headerContentType(type: string): string {
  return /^text\/|^application\/(json|x-subrip)$/.test(type) ? `${type}; charset=utf-8` : type;
}

interface LocalFile {
  path: string;
  relative: string;
  size: number;
  contentType: string;
}

/** file 在 root 之内（不含 root 本身）时返回正斜杠相对路径，否则 undefined */
function relativeInside(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
  return rel.split(path.sep).join('/');
}

/** 检查产物确实是输出目录里的普通文件；错误信息只带相对路径，不暴露服务器目录结构 */
async function describeLocalFile(file: string, root: string): Promise<LocalFile> {
  const absolute = path.resolve(file);
  const relative = relativeInside(root, absolute);
  if (relative === undefined) throw new Error(`产物不在输出目录内: ${path.basename(absolute)}`);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolute);
  } catch {
    throw new Error(`产物文件不存在: ${relative}`);
  }
  if (!stat.isFile()) throw new Error(`产物不是普通文件: ${relative}`);
  return { path: absolute, relative, size: stat.size, contentType: contentTypeFor(absolute) };
}

/**
 * 把产物交给存储，结果与 files 一一对应。本地模式只生成地址；S3 模式全部上传成功后返回地址，
 * 并按配置删除本地副本。任何一个文件上传失败都会中止其余上传、删掉本批已上传的对象并抛出中文错误。
 * signal 取消时同样中止并清理，以 signal.reason 拒绝。
 * S3 预签名模式下，HLS / DASH 播放列表里指向本批产物的相对引用会先换成预签名链接再上传（见 signPlaylists）
 */
export async function storeOutputs(
  files: string[],
  opts: { taskId: string; signal?: AbortSignal; settings?: StorageSettings },
): Promise<StoredOutput[]> {
  const settings = opts.settings ?? defaultStorageSettings();
  if (opts.signal?.aborted) throw opts.signal.reason;

  // 同一个文件出现多次只处理一次（例如 primary 也在 files 里）
  const unique = new Map<string, Promise<LocalFile>>();
  for (const file of files) {
    const key = path.resolve(file);
    if (!unique.has(key)) unique.set(key, describeLocalFile(key, settings.outputRoot));
  }
  const locals = await Promise.all(unique.values());
  const byPath = new Map(locals.map((item) => [item.path, item]));
  const pick = (file: string) => byPath.get(path.resolve(file)) as LocalFile;

  if (!settings.s3.bucket) {
    return files.map((file) => {
      const item = pick(file);
      return {
        path: item.path,
        url: localFileUrl(item.relative, settings.publicBaseUrl),
        size: item.size,
        contentType: item.contentType,
        storage: 'local' as const,
      };
    });
  }

  const s3 = settings.s3;
  const client = getS3Client(s3);
  const uploads: UploadItem[] = locals.map((item) => ({
    ...item,
    key: objectKey(item.relative, s3.prefix),
  }));
  // 地址在上传前生成：预签名只是本地计算签名，不依赖对象内容；改写播放列表要先拿到子文件的链接，
  // 而且签名失败时还没有对象落进桶里，不用清理
  const urls = new Map<string, string>();
  for (const item of uploads) urls.set(item.path, await objectUrl(client, s3, item.key));
  // 公开地址模式下相对引用按目录结构就能解析到公开地址，不用改
  if (!s3.publicBaseUrl) await signPlaylists(uploads, urls, opts.taskId);
  await uploadAll(client, s3, uploads, opts.signal);
  if (!s3.keepLocalCopy) await removeLocalCopies(locals, settings.outputRoot, opts.taskId);

  const byUpload = new Map(uploads.map((item) => [item.path, item]));
  return files.map((file) => {
    const item = byUpload.get(path.resolve(file)) as UploadItem;
    return {
      path: item.path,
      url: urls.get(item.path) as string,
      size: item.body?.length ?? item.size,
      contentType: item.contentType,
      storage: 's3' as const,
      key: item.key,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// 预签名模式下改写播放列表

// 播放列表都很小（每档最多 2000 个分片），超过这个大小说明不是正常产物，不读进内存
const MAX_PLAYLIST_BYTES = 16 * 1024 * 1024;

/**
 * 预签名链接只对单个对象有效。HLS 的 master / 分档列表和 DASH 的 manifest 用相对路径引用子文件，
 * 播放器按预签名的 master 地址解析出来的是不带签名的地址，私有桶一律 403。
 * 所以上传前把播放列表里指向本批产物的引用换成各自的预签名链接，改写后的内容放进 item.body 上传，
 * 本地文件保持原样（S3_KEEP_LOCAL_COPY=true 时本地目录仍能按相对路径播放）。
 * 签名不依赖对象内容，所有 key 已经先签好，所以不用按「分片 → 分档列表 → master」的顺序处理：
 * master 引用的是分档列表的 key，分档列表改写后 key 不变，链接也不变
 */
async function signPlaylists(
  uploads: UploadItem[],
  urls: Map<string, string>,
  taskId: string,
): Promise<void> {
  for (const item of uploads) {
    const kind = playlistKind(item.path);
    if (!kind) continue;
    if (item.size > MAX_PLAYLIST_BYTES) {
      throw new Error(`播放列表 ${item.relative} 超过 16 MB，无法改写成预签名链接`);
    }
    const dir = path.dirname(item.path);
    const missing = new Set<string>();
    const sign = (ref: string): string | undefined => {
      const targets = referenceTargets(ref, dir);
      if (!targets) return undefined; // 绝对地址等，不是本批产物
      for (const target of targets) {
        const url = urls.get(target);
        if (url) return url;
      }
      missing.add(ref);
      return undefined;
    };
    const original = await fs.promises.readFile(item.path, 'utf8');
    const name = path.basename(item.path);
    const rewritten =
      kind === 'hls'
        ? rewriteHlsPlaylist(original, sign)
        : rewriteDashManifest(original, sign, name);
    if (rewritten !== original) item.body = Buffer.from(rewritten, 'utf8');
    if (missing.size) {
      // 引用的文件不在产物里：本地模式下也播不了，这里不改，只提示
      const sample = [...missing].slice(0, 3).join(', ');
      console.warn(
        `[Task:${taskId}] 播放列表 ${item.relative} 引用了 ${missing.size} 个不在产物里的文件，` +
          `无法换成预签名链接: ${sample}`,
      );
    }
  }
}

function playlistKind(file: string): 'hls' | 'dash' | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.m3u8') return 'hls';
  if (ext === '.mpd') return 'dash';
  return undefined;
}

/**
 * 播放列表里的相对引用对应的本地绝对路径候选（先按 URL 解码后的名字，再按原样）。
 * 绝对地址（http:、data: 等）、以 / 开头的站点路径、空引用返回 undefined，原样保留。
 * 调用方只会把候选和本批产物比对，引用写成 ../ 跳出目录也只能命中本批产物里的文件
 */
function referenceTargets(ref: string, dir: string): string[] | undefined {
  const value = ref.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[/\\#?]/.test(value)) return undefined;
  const bare = value.replace(/[?#].*$/s, '');
  if (!bare) return undefined;
  const names = [bare];
  try {
    const decoded = decodeURIComponent(bare);
    if (decoded !== bare) names.unshift(decoded);
  } catch {
    // 不是合法的百分号编码，只按原样找
  }
  return names.map((name) => path.resolve(dir, ...name.split('/')));
}

// 属性里带地址（URI="..."）的 HLS 标签
const HLS_URI_TAGS = new Set([
  '#EXT-X-MAP',
  '#EXT-X-MEDIA',
  '#EXT-X-I-FRAME-STREAM-INF',
  '#EXT-X-KEY',
  '#EXT-X-SESSION-KEY',
  '#EXT-X-SESSION-DATA',
  '#EXT-X-PART',
  '#EXT-X-PRELOAD-HINT',
  '#EXT-X-RENDITION-REPORT',
]);

/**
 * 改写 HLS 播放列表（master 或分档列表）：URI 行（分档列表、分片）和上面这些标签的 URI 属性。
 * sign 返回 undefined 的引用原样保留；换行符（\n / \r\n）不变
 */
export function rewriteHlsPlaylist(
  text: string,
  sign: (ref: string) => string | undefined,
): string {
  return text
    .split('\n')
    .map((raw) => {
      const cr = raw.endsWith('\r') ? '\r' : '';
      const line = cr ? raw.slice(0, -1) : raw;
      const trimmed = line.trim();
      if (!trimmed) return raw;
      if (trimmed.startsWith('#')) {
        const colon = trimmed.indexOf(':');
        if (colon < 0 || !HLS_URI_TAGS.has(trimmed.slice(0, colon))) return raw;
        const next = rewriteHlsAttributes(trimmed, colon, sign);
        return next === trimmed ? raw : next + cr;
      }
      // 不以 # 开头的非空行都是 URI
      return (sign(trimmed) ?? line) + cr;
    })
    .join('\n');
}

/** 按属性列表语法（NAME=VALUE，逗号分隔，带引号的值里可以有逗号）逐个处理，只改 URI 属性 */
function rewriteHlsAttributes(
  line: string,
  colon: number,
  sign: (ref: string) => string | undefined,
): string {
  let out = line.slice(0, colon + 1);
  let i = colon + 1;
  while (i < line.length) {
    const eq = line.indexOf('=', i);
    if (eq < 0) return out + line.slice(i);
    const name = line.slice(i, eq);
    let end: number;
    if (line[eq + 1] === '"') {
      const close = line.indexOf('"', eq + 2);
      if (close < 0) return out + line.slice(i);
      end = close + 1;
      // 预签名链接里没有引号和换行，可以直接放进带引号的值
      const url = name.trim() === 'URI' ? sign(line.slice(eq + 2, close)) : undefined;
      out += url ? `${name}="${url}"` : line.slice(i, end);
    } else {
      const comma = line.indexOf(',', eq);
      end = comma < 0 ? line.length : comma;
      out += line.slice(i, end);
    }
    if (line[end] === ',') {
      out += ',';
      end++;
    }
    i = end;
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function xmlUnescape(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? whole;
    const code =
      entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

// 预签名链接的查询串里有 &，写进 XML 必须转义，否则清单解析失败
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// SegmentURL 的 media / index，Initialization、RepresentationIndex 的 sourceURL，SegmentTemplate 的 initialization
const DASH_URL_ATTR = /(\s(?:media|index|sourceURL|initialization)\s*=\s*)(["'])([^<]*?)\2/g;
const DASH_BASE_URL = /(<(?:[\w.-]+:)?BaseURL\b[^>]*>)([^<]*)(<\/(?:[\w.-]+:)?BaseURL\s*>)/g;
const DASH_SEGMENT_TEMPLATE = /<(?:[\w.-]+:)?SegmentTemplate\b/;

const PUBLIC_URL_HINT = '请设置 S3_PUBLIC_BASE_URL（公开读的存储桶或 CDN 地址），或改用本地存储';

/**
 * 改写 DASH 清单：SegmentList / SegmentBase 里逐个列出的分片、初始化分片和 BaseURL。
 * SegmentTemplate 按 $Number$ 这样的模板拼分片地址，没法给每个分片单独签名，直接报错；
 * 指向目录的 BaseURL 会改变子引用的解析基准，同样报错，不猜
 */
export function rewriteDashManifest(
  text: string,
  sign: (ref: string) => string | undefined,
  name = 'manifest.mpd',
): string {
  if (DASH_SEGMENT_TEMPLATE.test(text)) {
    throw new Error(
      `DASH 清单 ${name} 用 SegmentTemplate 按模板拼分片地址，预签名链接无法逐个替换，播放器取分片会被拒绝（403）；${PUBLIC_URL_HINT}`,
    );
  }
  const withBase = text.replace(
    DASH_BASE_URL,
    (whole, open: string, value: string, close: string) => {
      const ref = xmlUnescape(value).trim();
      if (!ref) return whole;
      const url = sign(ref);
      if (url) return `${open}${xmlEscape(url)}${close}`;
      throw new Error(
        `DASH 清单 ${name} 的 BaseURL（${ref}）不是本次产物里的文件，预签名模式下无法改写分片引用；${PUBLIC_URL_HINT}`,
      );
    },
  );
  return withBase.replace(DASH_URL_ATTR, (whole, head: string, quote: string, value: string) => {
    const url = sign(xmlUnescape(value));
    return url ? `${head}${quote}${xmlEscape(url)}${quote}` : whole;
  });
}

// ---------------------------------------------------------------------------------------------
// S3

// 跨文件最多 4 个同时上传；单文件时每个文件 4 个分片并发，多文件时 2 个，内存里最多缓冲约 64 MB
const UPLOAD_CONCURRENCY = 4;
const PART_SIZE = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;
const CLEANUP_TIMEOUT_MS = 30_000;

const clients = new Map<S3Settings, S3Client>();

function validateS3Settings(s3: S3Settings): void {
  if (s3.endpoint) {
    let protocol = '';
    try {
      protocol = new URL(s3.endpoint).protocol;
    } catch {
      // 下面统一报错
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`S3_ENDPOINT 不是合法的 http(s) 地址: ${s3.endpoint}`);
    }
  } else if (!s3.region || s3.region === 'auto') {
    throw new Error(
      '使用 AWS S3 时必须设置 S3_REGION（例如 us-east-1）；其他 S3 兼容存储请设置 S3_ENDPOINT',
    );
  }
  if (Boolean(s3.accessKeyId) !== Boolean(s3.secretAccessKey)) {
    throw new Error('S3_ACCESS_KEY_ID 和 S3_SECRET_ACCESS_KEY 必须同时设置');
  }
}

/** 每套配置一个 S3Client，第一次用到时创建 */
export function getS3Client(s3: S3Settings = config.s3): S3Client {
  const cached = clients.get(s3);
  if (cached) return cached;
  validateS3Settings(s3);
  // 自定义 endpoint 时只在协议要求时才算校验和：SDK 3.729 起默认给上传加 CRC32 并改用 aws-chunked 编码，
  // Cloudflare R2、阿里云 OSS 和旧版 MinIO 都出过不兼容（签名错误或 501）
  const checksum = s3.endpoint ? 'WHEN_REQUIRED' : 'WHEN_SUPPORTED';
  const client = new S3Client({
    region: s3.region || 'auto',
    endpoint: s3.endpoint || undefined,
    forcePathStyle: s3.forcePathStyle,
    // 不配密钥时走 SDK 默认凭证链（AWS_* 环境变量、ECS / EC2 实例角色等）
    credentials:
      s3.accessKeyId && s3.secretAccessKey
        ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
        : undefined,
    requestChecksumCalculation: checksum,
    responseChecksumValidation: checksum,
    // 默认没有任何超时，对象存储不可达时上传会一直挂着
    requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000 },
  });
  clients.set(s3, client);
  return client;
}

/** 关闭所有 S3 连接（优雅退出、测试结束时调用） */
export function closeStorage(): void {
  for (const client of clients.values()) client.destroy();
  clients.clear();
}

type SendFn = S3Client['send'];

/**
 * lib-storage 发请求时不带 abortSignal，取消后在途的分片或 PutObject 仍会传完，小文件甚至会在取消之后落进桶里。
 * 这里给它的每个请求注入 signal；AbortMultipartUpload 是取消后的清理请求，不能带已经取消的 signal
 */
function withAbortSignal(client: S3Client, signal: AbortSignal): S3Client {
  const send = ((command: Parameters<SendFn>[0], options?: Parameters<SendFn>[1]) =>
    command instanceof AbortMultipartUploadCommand
      ? client.send(command, options)
      : client.send(command, { ...options, abortSignal: signal })) as SendFn;
  return new Proxy(client, {
    get: (target, prop, receiver) => (prop === 'send' ? send : Reflect.get(target, prop, receiver)),
  });
}

interface UploadItem extends LocalFile {
  key: string;
  /** 要上传的内容（改写过的播放列表）；没有时从本地文件读 */
  body?: Buffer;
}

async function uploadOne(
  client: S3Client,
  s3: S3Settings,
  item: UploadItem,
  signal: AbortSignal,
  queueSize: number,
): Promise<void> {
  const stream = item.body ? undefined : fs.createReadStream(item.path);
  const size = item.body?.length ?? item.size;
  // lib-storage 用 signal.onabort 赋值监听取消，多个 Upload 共用一个 AbortController 时只有最后一个能收到，
  // 所以每个文件单独一个，再挂到批次的 signal 上
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    // 及时关掉文件句柄，Windows 上句柄没关时后面删本地文件会 EBUSY
    stream?.destroy();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Upload({
      client: withAbortSignal(client, signal),
      params: {
        Bucket: s3.bucket,
        Key: item.key,
        Body: item.body ?? stream,
        ContentLength: size,
        ContentType: headerContentType(item.contentType),
      },
      queueSize,
      partSize: Math.max(PART_SIZE, Math.ceil(size / MAX_PARTS)),
      leavePartsOnError: false,
      abortController: controller,
    }).done();
  } finally {
    signal.removeEventListener('abort', onAbort);
    stream?.destroy();
  }
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

async function uploadAll(
  client: S3Client,
  s3: S3Settings,
  items: UploadItem[],
  signal?: AbortSignal,
): Promise<void> {
  // 签名、读播放列表期间被取消：abort 事件已经发过，下面注册的监听收不到
  if (signal?.aborted) throw signal.reason;
  const batch = new AbortController();
  const onExternalAbort = () => batch.abort(signal?.reason);
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  const queueSize = items.length === 1 ? 4 : 2;
  const started: string[] = [];
  let failure: { key: string; error: unknown } | undefined;
  try {
    await runLimited(items, UPLOAD_CONCURRENCY, async (item) => {
      if (batch.signal.aborted) return;
      started.push(item.key);
      try {
        await uploadOne(client, s3, item, batch.signal, queueSize);
      } catch (error) {
        if (!batch.signal.aborted) {
          failure = { key: item.key, error };
          batch.abort(error);
        }
      }
    });
  } finally {
    signal?.removeEventListener('abort', onExternalAbort);
  }
  if (!batch.signal.aborted) return;

  // 半途失败或取消时，已经传上去的对象没人引用，删掉免得在桶里堆积；DeleteObject 对不存在的 key 也返回成功。
  // 失败的那个文件本身没有落进桶（分片上传由 lib-storage 中止），不用删
  await deleteObjects(
    client,
    s3.bucket,
    started.filter((key) => key !== failure?.key),
  );
  if (signal?.aborted) throw signal.reason;
  if (failure) {
    throw new Error(
      `上传到对象存储失败（${shortKey(failure.key)}）：${explainS3Error(failure.error, s3)}`,
    );
  }
  throw new Error('上传到对象存储失败：上传被中止');
}

// 错误信息会写进任务详情，超长的 key 只留头尾
function shortKey(key: string): string {
  return key.length <= 200 ? key : `${key.slice(0, 120)}…${key.slice(-60)}`;
}

/**
 * 逐个删除而不用 DeleteObjects：批量删除要求 Content-MD5 或校验和头，阿里云 OSS 等对 SDK 新版的
 * 校验和头支持不全。只在失败路径上用，数量不多
 */
async function deleteObjects(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  const timeout = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  await runLimited(keys, 8, async (key) => {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: timeout,
      });
    } catch (err) {
      console.warn(`[Storage] 清理已上传对象失败 ${key}: ${describeError(err)}`);
    }
  });
}

interface S3ErrorShape {
  name?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

/** 把 SDK 的英文错误名翻译成能照着改配置的提示 */
export function explainS3Error(err: unknown, s3: S3Settings = config.s3): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as S3ErrorShape;
  const name = e.name ?? '';
  const status = e.$metadata?.httpStatusCode;
  const detail = describeError(err);
  switch (name) {
    case 'NoSuchBucket':
      return `存储桶 ${s3.bucket} 不存在`;
    case 'InvalidAccessKeyId':
      return 'S3_ACCESS_KEY_ID 无效';
    case 'SignatureDoesNotMatch':
      return '签名不匹配，检查 S3_SECRET_ACCESS_KEY 和 S3_REGION';
    case 'AuthorizationHeaderMalformed':
    case 'PermanentRedirect':
    case 'IllegalLocationConstraintException':
      return `存储桶所在区域与 S3_REGION（${s3.region}）不一致`;
    case 'AccessDenied':
    case 'Forbidden':
      return '没有写入权限（AccessDenied），检查密钥对这个存储桶的 PutObject 权限';
    case 'InvalidBucketName':
      return `存储桶名称不合法: ${s3.bucket}`;
    case 'KeyTooLongError':
      return '对象 key 超过 1024 字节，缩短 S3_PREFIX 或产物路径';
    case 'RequestTimeTooSkewed':
      return '服务器时钟与对象存储相差超过 15 分钟，检查系统时间同步';
    case 'SlowDown':
    case 'ServiceUnavailable':
      return `对象存储繁忙或限流，稍后重试: ${detail}`;
    case 'NotImplemented':
      return `对象存储不支持这个请求（S3 兼容性问题）: ${detail}`;
    case 'TimeoutError':
      return `连接对象存储超时: ${detail}`;
  }
  if (status === 403) return `对象存储拒绝访问（HTTP 403）: ${detail}`;
  if (e.code && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT)$/.test(e.code)) {
    return `连不上对象存储 ${s3.endpoint || 'AWS S3'}（${e.code}）`;
  }
  return detail;
}

async function objectUrl(client: S3Client, s3: S3Settings, key: string): Promise<string> {
  if (s3.publicBaseUrl) return `${s3.publicBaseUrl}/${encodeUrlPath(key)}`;
  try {
    return await getSignedUrl(client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), {
      expiresIn: s3.presignExpiresSeconds,
    });
  } catch (err) {
    throw new Error(`生成下载链接失败（${key}）：${explainS3Error(err, s3)}`);
  }
}

/** 删掉已上传的本地副本，再自下而上删掉因此变空的子目录（HLS / 分段等目录产物） */
async function removeLocalCopies(files: LocalFile[], root: string, taskId: string): Promise<void> {
  const dirs = new Set<string>();
  for (const file of files) {
    try {
      await fs.promises.rm(file.path, { force: true });
      dirs.add(path.dirname(file.path));
    } catch (err) {
      console.warn(`[Task:${taskId}] 删除本地副本失败 ${file.relative}: ${describeError(err)}`);
    }
  }
  const rootResolved = path.resolve(root);
  // 深的先删，父目录才可能变空
  const ordered = [...dirs].sort((a, b) => b.length - a.length);
  for (let dir of ordered) {
    while (dir !== rootResolved && dir.startsWith(rootResolved + path.sep)) {
      try {
        await fs.promises.rmdir(dir);
      } catch {
        break; // 非空或已删除
      }
      dir = path.dirname(dir);
    }
  }
}

/**
 * 撤销 storeOutputs：删掉对象存储里的对象、输出目录里的本地文件和因此变空的子目录。
 * 给引擎在上传完成后才发现任务已被取消时用，否则这些对象没人引用，一直占着桶。失败只打日志，不抛错
 */
export async function deleteStoredOutputs(
  stored: StoredOutput[],
  opts: { taskId: string; settings?: StorageSettings },
): Promise<void> {
  const settings = opts.settings ?? defaultStorageSettings();
  const keys = [...new Set(stored.flatMap((s) => (s.storage === 's3' && s.key ? [s.key] : [])))];
  if (keys.length && settings.s3.bucket) {
    try {
      await deleteObjects(getS3Client(settings.s3), settings.s3.bucket, keys);
    } catch (err) {
      console.warn(`[Task:${opts.taskId}] 删除已上传对象失败: ${describeError(err)}`);
    }
  }
  const root = path.resolve(settings.outputRoot);
  const locals: LocalFile[] = [];
  for (const file of new Set(stored.map((s) => path.resolve(s.path)))) {
    // 只删输出目录里的东西
    const relative = relativeInside(root, file);
    if (relative !== undefined) locals.push({ path: file, relative, size: 0, contentType: '' });
  }
  await removeLocalCopies(locals, root, opts.taskId);
}

/** 健康检查用：本地模式检查输出目录可写，S3 模式对存储桶发一次 HeadBucket */
export async function checkStorage(
  opts: { settings?: StorageSettings; timeoutMs?: number } = {},
): Promise<{ driver: 'local' | 's3'; ok: boolean; error?: string }> {
  const settings = opts.settings ?? defaultStorageSettings();
  if (!settings.s3.bucket) {
    try {
      await fs.promises.access(settings.outputRoot, fs.constants.W_OK);
      return { driver: 'local', ok: true };
    } catch (err) {
      // 只给错误码：健康检查可能不鉴权，errno 消息里带服务器上的绝对路径
      const code = (err as NodeJS.ErrnoException).code ?? '未知错误';
      return { driver: 'local', ok: false, error: `输出目录不可写（${code}）` };
    }
  }
  try {
    const client = getS3Client(settings.s3);
    await client.send(new HeadBucketCommand({ Bucket: settings.s3.bucket }), {
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    return { driver: 's3', ok: true };
  } catch (err) {
    // HeadBucket 没有响应体，错误名只有 NotFound / Forbidden 这类
    const e = err as S3ErrorShape;
    const reason =
      e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404
        ? `存储桶 ${settings.s3.bucket} 不存在`
        : explainS3Error(err, settings.s3);
    return { driver: 's3', ok: false, error: reason };
  }
}

// ---------------------------------------------------------------------------------------------
// 过期清理

const HOUR_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 30 * 1000;
// 正常任务早就结束了；进程崩溃、容器被杀时 uploads 里会留下上传文件和任务临时目录，没人会再删
const STALE_WORK_HOURS = 48;
// 仓库用来保留空目录的占位文件
const KEEP_NAMES = new Set(['.gitkeep', '.gitignore']);

export interface SweepStats {
  /** 删除的顶层条目数（一个目录算一项） */
  removed: number;
  bytes: number;
  /** 删除失败的条目数（例如 Windows 上文件正被占用） */
  failed: number;
}

/** 文件取自身 mtime；目录取它自己和其中所有文件里最新的 mtime。符号链接不跟随 */
async function entryAge(target: string): Promise<{ newest: number; bytes: number }> {
  const stat = await fs.promises.lstat(target);
  if (!stat.isDirectory()) return { newest: stat.mtimeMs, bytes: stat.size };
  // 目录自身的 mtime 也算：新建的任务目录里可能只有硬链接进来的旧字体文件，只看文件会被误删
  let newest = stat.mtimeMs;
  let bytes = 0;
  for (const child of await fs.promises.readdir(target)) {
    const sub = await entryAge(path.join(target, child));
    newest = Math.max(newest, sub.newest);
    bytes += sub.bytes;
  }
  return { newest, bytes };
}

/** 删除 dir 下所有比 cutoffMs 旧的顶层条目（文件或整个目录），dir 本身保留 */
export async function sweepExpired(dir: string, cutoffMs: number): Promise<SweepStats> {
  const stats: SweepStats = { removed: 0, bytes: 0, failed: 0 };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return stats;
    throw err;
  }
  for (const name of names) {
    if (KEEP_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const { newest, bytes } = await entryAge(full);
      if (newest >= cutoffMs) continue;
      await fs.promises.rm(full, { recursive: true, force: true });
      stats.removed++;
      stats.bytes += bytes;
    } catch (err) {
      // 扫描途中被任务自己删掉了
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      stats.failed++;
      console.warn(`[Storage] 删除过期文件失败 ${name}: ${describeError(err)}`);
    }
  }
  return stats;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function logSweep(label: string, stats: SweepStats): void {
  if (!stats.removed && !stats.failed) return;
  const failed = stats.failed ? `，${stats.failed} 项删除失败` : '';
  console.log(
    `[Storage] 清理${label}：删除 ${stats.removed} 项，释放 ${formatBytes(stats.bytes)}${failed}`,
  );
}

export interface RetentionOptions {
  now?: number;
  /** 默认 config.outputDir */
  outputDir?: string;
  /** 默认 config.uploadDir */
  uploadDir?: string;
  /** 默认 config.outputRetentionHours，0 表示不清理产物 */
  retentionHours?: number;
}

/** 执行一轮清理：按 OUTPUT_RETENTION_HOURS 清输出目录（0 表示不清），uploads 里超过 48 小时的残留总是清 */
export async function runRetentionSweep(
  opts: RetentionOptions = {},
): Promise<{ output: SweepStats | null; uploads: SweepStats }> {
  const now = opts.now ?? Date.now();
  const hours = opts.retentionHours ?? config.outputRetentionHours;
  let output: SweepStats | null = null;
  if (hours > 0) {
    output = await sweepExpired(opts.outputDir ?? config.outputDir, now - hours * HOUR_MS);
    logSweep(`超过 ${hours} 小时的产物`, output);
  }
  const uploads = await sweepExpired(
    opts.uploadDir ?? config.uploadDir,
    now - STALE_WORK_HOURS * HOUR_MS,
  );
  logSweep(`超过 ${STALE_WORK_HOURS} 小时的上传文件和任务临时目录`, uploads);
  return { output, uploads };
}

/** 启动本地输出文件的过期清理（OUTPUT_RETENTION_HOURS），返回停止函数 */
export function startOutputRetentionSweeper(): () => void {
  const hours = config.outputRetentionHours;
  if (hours > 0) {
    console.log(`[Storage] 本地产物保留 ${hours} 小时，每 10 分钟清理一次`);
    if (hours * 3600 < config.taskTtlSeconds) {
      console.warn(
        `[Storage] OUTPUT_RETENTION_HOURS（${hours}）短于任务记录保留时间 TASK_TTL_SECONDS，` +
          '任务详情里的本地下载地址会先失效',
      );
    }
  }
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    runRetentionSweep()
      .catch((err) => console.error(`[Storage] 过期清理失败: ${describeError(err)}`))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, FIRST_SWEEP_DELAY_MS);
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  first.unref();
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
