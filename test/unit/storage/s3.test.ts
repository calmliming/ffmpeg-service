import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  checkStorage,
  closeStorage,
  deleteStoredOutputs,
  getS3Client,
  storeOutputs,
  type S3Settings,
  type StorageSettings,
} from '../../../src/services/storage.service';
import { ffmpegSkip, generate, makeTempDir } from '../../helpers/media';

// 需要一个 MinIO（或其他 S3 兼容服务）。本地起一个：
//   docker run -d --name ffmpeg-svc-minio-test -p 127.0.0.1:9000:9000 \
//     -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
//     pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
// 连不上时这一组测试全部跳过
const endpoint = (process.env.MINIO_TEST_ENDPOINT ?? 'http://127.0.0.1:9000').replace(/\/+$/, '');
const accessKeyId = process.env.MINIO_TEST_ACCESS_KEY ?? 'minioadmin';
const secretAccessKey = process.env.MINIO_TEST_SECRET_KEY ?? 'minioadmin';
const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const privateBucket = `ffsvc-test-${runId}`;
const publicBucket = `ffsvc-test-pub-${runId}`;

let available = false;
let admin: S3Client;
let root: string;

function settings(overrides: Partial<S3Settings> = {}): StorageSettings {
  return {
    outputRoot: root,
    publicBaseUrl: '',
    s3: {
      bucket: privateBucket,
      endpoint,
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true,
      prefix: '',
      publicBaseUrl: '',
      presignExpiresSeconds: 600,
      keepLocalCopy: false,
      ...overrides,
    },
  };
}

function writeFile(relative: string, data: Buffer): string {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

async function download(url: string): Promise<{ status: number; type: string; body: Buffer }> {
  const res = await fetch(url);
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    body: Buffer.from(await res.arrayBuffer()),
  };
}

async function exists(bucket: string, key: string): Promise<boolean> {
  try {
    await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function skipIfUnavailable(t: TestContext): boolean {
  if (!available) t.skip(`连不上 MinIO（${endpoint}）`);
  return !available;
}

before(async () => {
  try {
    const res = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
    available = res.ok;
  } catch {
    available = false;
  }
  if (!available) return;
  root = makeTempDir('ffsvc-s3-');
  admin = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  await admin.send(new CreateBucketCommand({ Bucket: privateBucket }));
  await admin.send(new CreateBucketCommand({ Bucket: publicBucket }));
  await admin.send(
    new PutBucketPolicyCommand({
      Bucket: publicBucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${publicBucket}/*`],
          },
        ],
      }),
    }),
  );
});

after(async () => {
  closeStorage();
  if (!available) return;
  for (const bucket of [privateBucket, publicBucket]) {
    const listed = await admin.send(new ListObjectsV2Command({ Bucket: bucket }));
    for (const item of listed.Contents ?? []) {
      await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
    }
    await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
  admin.destroy();
  fs.rmSync(root, { recursive: true, force: true });
});

test('预签名模式：上传后返回可下载的签名链接，删除本地副本和变空的子目录', async (t) => {
  if (skipIfUnavailable(t)) return;
  const data = crypto.randomBytes(64 * 1024);
  const file = writeFile('task-a/out.mp4', data);
  const [stored] = await storeOutputs([file], { taskId: 'a', settings: settings() });

  assert.equal(stored.storage, 's3');
  assert.equal(stored.key, 'task-a/out.mp4');
  assert.equal(stored.size, data.length);
  assert.equal(stored.contentType, 'video/mp4');
  assert.equal(stored.path, path.resolve(file));
  assert.match(stored.url, /^http:\/\/127\.0\.0\.1:9000\/ffsvc-test-[^/]+\/task-a\/out\.mp4\?/);
  assert.match(stored.url, /X-Amz-Signature=/);
  assert.match(stored.url, /X-Amz-Expires=600/);

  const got = await download(stored.url);
  assert.equal(got.status, 200);
  assert.equal(got.type, 'video/mp4');
  assert.ok(got.body.equals(data), '下载内容与本地文件一致');

  // 没签名直接访问私有桶会被拒绝
  assert.equal((await download(stored.url.split('?')[0])).status, 403);
  assert.ok(!fs.existsSync(file), '上传成功后删除本地副本');
  assert.ok(!fs.existsSync(path.join(root, 'task-a')), '变空的子目录也删除');
  assert.ok(fs.existsSync(root), '输出根目录保留');
});

test('公开地址模式：S3_PUBLIC_BASE_URL + 前缀 + 编码后的 key，文本类型带 charset', async (t) => {
  if (skipIfUnavailable(t)) return;
  const subtitle = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\n你好，世界\n', 'utf8');
  const file = writeFile('sub dir/字幕.vtt', subtitle);
  const [stored] = await storeOutputs([file], {
    taskId: 'b',
    settings: settings({
      bucket: publicBucket,
      prefix: 'media/out',
      publicBaseUrl: `${endpoint}/${publicBucket}`,
    }),
  });
  assert.equal(stored.key, 'media/out/sub dir/字幕.vtt');
  assert.equal(
    stored.url,
    `${endpoint}/${publicBucket}/media/out/sub%20dir/%E5%AD%97%E5%B9%95.vtt`,
  );
  assert.equal(stored.contentType, 'text/vtt');
  const got = await download(stored.url);
  assert.equal(got.status, 200);
  assert.equal(got.type, 'text/vtt; charset=utf-8');
  assert.ok(got.body.equals(subtitle));
});

test('S3_KEEP_LOCAL_COPY=true 时保留本地副本', async (t) => {
  if (skipIfUnavailable(t)) return;
  const file = writeFile('keep/a.mp3', crypto.randomBytes(1000));
  const [stored] = await storeOutputs([file], {
    taskId: 'c',
    settings: settings({ keepLocalCopy: true }),
  });
  assert.ok(fs.existsSync(file));
  assert.ok(await exists(privateBucket, stored.key ?? ''));
  assert.equal(stored.contentType, 'audio/mpeg');
  fs.rmSync(path.join(root, 'keep'), { recursive: true, force: true });
});

test('目录产物（HLS）：嵌套路径全部上传，key 保留目录结构，本地目录整体清空', async (t) => {
  if (skipIfUnavailable(t)) return;
  const files = [
    writeFile('hls1/master.m3u8', Buffer.from('#EXTM3U\n')),
    writeFile('hls1/v0/index.m3u8', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n')),
    ...Array.from({ length: 6 }, (_, i) =>
      writeFile(`hls1/v0/seg_${i}.ts`, crypto.randomBytes(2000 + i)),
    ),
    writeFile('hls1/v1 audio/init.m4s', crypto.randomBytes(300)),
  ];
  const stored = await storeOutputs(files, {
    taskId: 'd',
    settings: settings({ prefix: 'p' }),
  });
  assert.equal(stored.length, files.length);
  assert.deepEqual(
    stored.map((s) => s.key),
    [
      'p/hls1/master.m3u8',
      'p/hls1/v0/index.m3u8',
      ...Array.from({ length: 6 }, (_, i) => `p/hls1/v0/seg_${i}.ts`),
      'p/hls1/v1 audio/init.m4s',
    ],
  );
  assert.equal(stored[0].contentType, 'application/vnd.apple.mpegurl');
  assert.equal(stored[2].contentType, 'video/mp2t');
  assert.equal(stored[8].contentType, 'video/iso.segment');
  for (const item of stored) assert.ok(await exists(privateBucket, item.key ?? ''), item.key);
  const seg = await download(stored[5].url);
  assert.equal(seg.body.length, 2003);
  assert.ok(!fs.existsSync(path.join(root, 'hls1')), '整个目录产物都已删除');
});

test('大文件走分片上传，内容一致', async (t) => {
  if (skipIfUnavailable(t)) return;
  const data = crypto.randomBytes(17 * 1024 * 1024 + 123);
  const file = writeFile('big/large.mkv', data);
  const [stored] = await storeOutputs([file], { taskId: 'e', settings: settings() });
  const got = await download(stored.url);
  assert.equal(got.status, 200);
  assert.equal(got.type, 'video/x-matroska');
  assert.equal(
    crypto.createHash('sha256').update(got.body).digest('hex'),
    crypto.createHash('sha256').update(data).digest('hex'),
  );
});

test('取消：上传途中 abort 以 signal.reason 拒绝，桶里不留对象，本地文件可以删除', async (t) => {
  if (skipIfUnavailable(t)) return;
  const small = writeFile('cancel/a.mp4', crypto.randomBytes(1000));
  const large = writeFile('cancel/b.mp4', crypto.randomBytes(48 * 1024 * 1024));
  const controller = new AbortController();
  const reason = new Error('任务已取消');
  const pending = storeOutputs([small, large], {
    taskId: 'f',
    signal: controller.signal,
    settings: settings(),
  });
  setTimeout(() => controller.abort(reason), 150);
  await assert.rejects(pending, (err) => err === reason);

  assert.ok(!(await exists(privateBucket, 'cancel/a.mp4')), '已传完的小文件被清理');
  assert.ok(!(await exists(privateBucket, 'cancel/b.mp4')));
  // 本地文件留给引擎清理；句柄已关闭，Windows 上也能立即删除
  assert.ok(fs.existsSync(large));
  fs.rmSync(path.join(root, 'cancel'), { recursive: true });
});

test('开始前已取消：不发任何请求', async (t) => {
  if (skipIfUnavailable(t)) return;
  const file = writeFile('pre/a.mp4', Buffer.from('x'));
  const controller = new AbortController();
  controller.abort(new Error('任务已取消'));
  await assert.rejects(
    storeOutputs([file], { taskId: 'g', signal: controller.signal, settings: settings() }),
    { message: '任务已取消' },
  );
  assert.ok(!(await exists(privateBucket, 'pre/a.mp4')));
  fs.rmSync(path.join(root, 'pre'), { recursive: true });
});

test('失败时报中文错误：存储桶不存在、密钥错误；本地文件保留', async (t) => {
  if (skipIfUnavailable(t)) return;
  const file = writeFile('fail/a.mp4', Buffer.from('x'));
  await assert.rejects(
    storeOutputs([file], { taskId: 'h', settings: settings({ bucket: 'ffsvc-no-such-bucket' }) }),
    { message: '上传到对象存储失败（fail/a.mp4）：存储桶 ffsvc-no-such-bucket 不存在' },
  );
  await assert.rejects(
    storeOutputs([file], { taskId: 'h', settings: settings({ accessKeyId: 'wrong-key' }) }),
    { message: '上传到对象存储失败（fail/a.mp4）：S3_ACCESS_KEY_ID 无效' },
  );
  await assert.rejects(
    storeOutputs([file], { taskId: 'h', settings: settings({ secretAccessKey: 'wrong-secret' }) }),
    {
      message:
        '上传到对象存储失败（fail/a.mp4）：签名不匹配，检查 S3_SECRET_ACCESS_KEY 和 S3_REGION',
    },
  );
  assert.ok(fs.existsSync(file));
  fs.rmSync(path.join(root, 'fail'), { recursive: true });
});

test('多文件中有文件缺失：上传前就报错，什么都不传', async (t) => {
  if (skipIfUnavailable(t)) return;
  const good = writeFile('missing/good.mp4', crypto.randomBytes(500));
  await assert.rejects(
    storeOutputs([good, path.join(root, 'missing', 'gone.mp4')], {
      taskId: 'i',
      settings: settings(),
    }),
    { message: '产物文件不存在: missing/gone.mp4' },
  );
  assert.ok(!(await exists(privateBucket, 'missing/good.mp4')));
  assert.ok(fs.existsSync(good));
  fs.rmSync(path.join(root, 'missing'), { recursive: true });
});

test('多文件中一个上传失败：报中文错误，其余已上传的对象被删除，本地文件保留', async (t) => {
  if (skipIfUnavailable(t)) return;
  const good = Array.from({ length: 5 }, (_, i) =>
    writeFile(`partial/good${i}.mp4`, crypto.randomBytes(500 + i)),
  );
  // 对象 key 最长 1024 字节，超长的会被对象存储拒绝。分成几层目录，避开单个文件名 255 字符的限制
  const deep = Array.from({ length: 6 }, (_, i) => `${i}${'d'.repeat(199)}`).join('/');
  const bad = writeFile(`partial/${deep}/bad.mp4`, Buffer.from('y'));
  await assert.rejects(
    storeOutputs([...good, bad], { taskId: 'i', settings: settings() }),
    (err: Error) => {
      // 超长 key 在错误信息里只留头尾
      assert.ok(err.message.startsWith(`上传到对象存储失败（partial/0${'d'.repeat(111)}…`));
      assert.ok(
        err.message.endsWith('/bad.mp4）：对象 key 超过 1024 字节，缩短 S3_PREFIX 或产物路径'),
      );
      return true;
    },
  );
  for (let i = 0; i < good.length; i++) {
    assert.ok(!(await exists(privateBucket, `partial/good${i}.mp4`)), `partial/good${i}.mp4`);
    assert.ok(fs.existsSync(good[i]), '失败时本地文件留给引擎清理');
  }
  fs.rmSync(path.join(root, 'partial'), { recursive: true, force: true });
});

test('deleteStoredOutputs：删除已上传的对象、本地副本和变空的目录', async (t) => {
  if (skipIfUnavailable(t)) return;
  const files = [
    writeFile('undo/v0/a.ts', crypto.randomBytes(100)),
    writeFile('undo/index.m3u8', Buffer.from('#EXTM3U\n')),
  ];
  const s = settings({ keepLocalCopy: true, prefix: 'u' });
  const stored = await storeOutputs(files, { taskId: 'j', settings: s });
  for (const item of stored) assert.ok(await exists(privateBucket, item.key ?? ''));
  await deleteStoredOutputs(stored, { taskId: 'j', settings: s });
  for (const item of stored) assert.ok(!(await exists(privateBucket, item.key ?? '')), item.key);
  assert.ok(!fs.existsSync(path.join(root, 'undo')), '本地副本和空目录都已删除');
  assert.ok(fs.existsSync(root));
  // 再删一次（对象和文件都已不存在）不报错
  await deleteStoredOutputs(stored, { taskId: 'j', settings: s });
});

test('配置检查：AWS S3 缺区域、endpoint 非法、密钥只配一半', async () => {
  const base = settings().s3;
  assert.throws(() => getS3Client({ ...base, endpoint: '', region: 'auto' }), {
    message:
      '使用 AWS S3 时必须设置 S3_REGION（例如 us-east-1）；其他 S3 兼容存储请设置 S3_ENDPOINT',
  });
  assert.throws(() => getS3Client({ ...base, endpoint: 'ftp://x' }), {
    message: 'S3_ENDPOINT 不是合法的 http(s) 地址: ftp://x',
  });
  assert.throws(() => getS3Client({ ...base, secretAccessKey: '' }), {
    message: 'S3_ACCESS_KEY_ID 和 S3_SECRET_ACCESS_KEY 必须同时设置',
  });
});

// ---------------------------------------------------------------------------------------------
// HLS / DASH 目录产物：预签名模式下播放列表里的引用必须换成预签名链接，否则播放器取子文件 403

/** FFmpeg 的 HLS / DASH 模板会把 Windows 反斜杠路径弄乱，统一用正斜杠（与 streaming.ts 的 muxerDir 一致） */
function muxerPath(dir: string): string {
  return dir.split(path.sep).join('/');
}

const LADDER = [
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x120:rate=10:duration=3',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=3',
  '-filter_complex',
  '[0:v]split=2[a][b];[a]scale=160:120[v0];[b]scale=80:60[v1]',
  '-map',
  '[v0]',
  '-map',
  '[v1]',
];
const ENCODE = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', '-ac', '2'];

/** 与 video.hls 相同的布局：master.m3u8 + 两档分档列表 + 分片（fmp4 时每档还有 _init.mp4） */
function makeHlsTree(relativeDir: string, segmentType: 'ts' | 'fmp4'): string[] {
  const dir = path.join(root, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  const out = muxerPath(dir);
  const ext = segmentType === 'fmp4' ? 'm4s' : 'ts';
  generate([
    ...LADDER,
    '-map',
    '1:a',
    '-map',
    '1:a',
    ...ENCODE,
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    segmentType === 'fmp4' ? 'fmp4' : 'mpegts',
    ...(segmentType === 'fmp4' ? ['-hls_fmp4_init_filename', '%v_init.mp4'] : []),
    '-hls_segment_filename',
    `${out}/%v_%03d.${ext}`,
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    'v:0,a:0,name:120p v:1,a:1,name:60p',
    `${out}/%v.m3u8`,
  ]);
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

/** SegmentList 形式的 DASH（-use_template 0），同时生成引用同一批分片的 HLS 播放列表 */
function makeDashTree(relativeDir: string, useTemplate: boolean): string[] {
  const dir = path.join(root, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  generate([
    ...LADDER,
    '-map',
    '1:a',
    ...ENCODE,
    '-f',
    'dash',
    '-seg_duration',
    '1',
    '-use_template',
    useTemplate ? '1' : '0',
    '-use_timeline',
    '1',
    '-adaptation_sets',
    'id=0,streams=v id=1,streams=a',
    '-hls_playlist',
    '1',
    '-hls_master_name',
    'master.m3u8',
    `${muxerPath(dir)}/manifest.mpd`,
  ]);
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 播放器会去取的全部引用：HLS 的 URI 行和 URI 属性，DASH 的分片 / 初始化分片地址和 BaseURL */
function playlistRefs(name: string, text: string): string[] {
  if (name.endsWith('.m3u8')) {
    const refs: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.startsWith('#')) refs.push(line);
      else for (const m of line.matchAll(/[:,]URI="([^"]*)"/g)) refs.push(m[1]);
    }
    return refs;
  }
  if (name.endsWith('.mpd')) {
    const refs = [...text.matchAll(/\s(?:media|sourceURL|initialization|index)="([^"]*)"/g)];
    const bases = [...text.matchAll(/<BaseURL>([^<]*)<\/BaseURL>/g)];
    return [...refs, ...bases].map((m) => unescapeXml(m[1]));
  }
  return [];
}

interface Crawled {
  status: number;
  body: Buffer;
  refs: string[];
}

/** 像播放器一样从入口地址出发，按相对地址解析规则逐个取引用，返回 对象路径 → 结果 */
async function crawl(start: string): Promise<Map<string, Crawled>> {
  const seen = new Map<string, Crawled>();
  const queue = [start];
  while (queue.length) {
    const url = queue.shift() as string;
    const objectPath = decodeURIComponent(new URL(url).pathname);
    if (seen.has(objectPath)) continue;
    const got = await download(url);
    const refs = got.status === 200 ? playlistRefs(objectPath, got.body.toString('utf8')) : [];
    seen.set(objectPath, { status: got.status, body: got.body, refs });
    for (const ref of refs) queue.push(new URL(ref, url).href);
  }
  return seen;
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** 上传前记下媒体文件的哈希（上传后本地副本会被删掉） */
function hashMedia(files: string[]): Map<string, string> {
  return new Map(
    files
      .filter((f) => !/\.(m3u8|mpd)$/.test(f))
      .map((f) => [path.basename(f), sha256(fs.readFileSync(f))]),
  );
}

async function assertPlayable(
  primaryUrl: string,
  stored: Awaited<ReturnType<typeof storeOutputs>>,
  bucket: string,
  media: Map<string, string>,
  expectSigned: boolean,
) {
  const crawled = await crawl(primaryUrl);
  for (const [objectPath, item] of crawled) assert.equal(item.status, 200, objectPath);
  // 每个产物都能从入口地址走到，也没有走到产物以外的对象
  assert.deepEqual([...crawled.keys()].sort(), stored.map((s) => `/${bucket}/${s.key}`).sort());
  for (const [objectPath, item] of crawled) {
    const name = path.posix.basename(objectPath);
    const hash = media.get(name);
    if (hash) assert.equal(sha256(item.body), hash, `${name} 内容一致`);
    else {
      assert.ok(item.refs.length > 0, `${name} 有引用`);
      for (const ref of item.refs) {
        if (expectSigned) {
          assert.match(ref, /^http:\/\/127\.0\.0\.1:9000\/.*X-Amz-Signature=/, `${name}: ${ref}`);
        } else assert.doesNotMatch(ref, /^https?:|X-Amz-/, `${name}: ${ref}`);
      }
    }
  }
  // size 是桶里对象的实际大小（改写后的播放列表比本地文件大）
  for (const s of stored) {
    assert.equal(crawled.get(`/${bucket}/${s.key}`)?.body.length, s.size, s.key);
  }
  return crawled;
}

for (const segmentType of ['ts', 'fmp4'] as const) {
  test(
    `预签名模式：HLS（${segmentType}，master + 两档）从 master 的预签名链接出发，每个引用都能取到`,
    { skip: ffmpegSkip },
    async (t) => {
      if (skipIfUnavailable(t)) return;
      const files = makeHlsTree(`hls-presign-${segmentType}`, segmentType);
      const media = hashMedia(files);
      const original = fs.readFileSync(path.join(root, `hls-presign-${segmentType}`, '120p.m3u8'));
      const master = files.find((f) => path.basename(f) === 'master.m3u8') as string;
      const stored = await storeOutputs(files, {
        taskId: 'hls',
        settings: settings({ prefix: 'streams' }),
      });
      const primary = stored.find((s) => s.path === path.resolve(master));
      assert.ok(primary);
      const crawled = await assertPlayable(primary.url, stored, privateBucket, media, true);
      // master + 2 个分档列表 + 每档 3 个分片（fmp4 再加 2 个 init）
      assert.equal(crawled.size, segmentType === 'fmp4' ? 11 : 9);
      // 私有桶本身没变：去掉签名的地址仍然 403
      const variant = stored.find((s) => s.key?.endsWith('/120p.m3u8'));
      assert.equal((await download((variant?.url ?? '').split('?')[0])).status, 403);
      assert.ok(original.length < (variant?.size ?? 0), '桶里的分档列表是改写后的');
      assert.ok(!fs.existsSync(path.join(root, `hls-presign-${segmentType}`)));
    },
  );
}

test(
  '预签名模式：DASH（SegmentList）和附带的 HLS 列表，manifest 与 master 出发都能取到所有分片',
  { skip: ffmpegSkip },
  async (t) => {
    if (skipIfUnavailable(t)) return;
    const files = makeDashTree('dash-presign', false);
    const media = hashMedia(files);
    const stored = await storeOutputs(files, { taskId: 'dash', settings: settings() });
    const manifest = stored.find((s) => s.key === 'dash-presign/manifest.mpd');
    const hlsMaster = stored.find((s) => s.key === 'dash-presign/master.m3u8');
    assert.ok(manifest && hlsMaster);
    assert.equal(manifest.contentType, 'application/dash+xml');

    // 从 manifest 出发走到的是全部分片和初始化分片（HLS 列表不在 manifest 里）
    const fromMpd = await crawl(manifest.url);
    for (const [objectPath, item] of fromMpd) assert.equal(item.status, 200, objectPath);
    const segments = stored.filter((s) => /\.m4s$/.test(s.key ?? ''));
    assert.equal(fromMpd.size, 1 + segments.length);
    for (const s of segments) {
      const got = fromMpd.get(`/${privateBucket}/${s.key}`);
      assert.equal(got?.body.length, s.size, s.key);
      assert.equal(
        sha256(got?.body ?? Buffer.alloc(0)),
        media.get(path.posix.basename(s.key ?? '')),
        s.key,
      );
    }
    // 改写后仍然是合法的 XML：查询串里的 & 已转义
    const mpdText = (fromMpd.get(`/${privateBucket}/${manifest.key}`)?.body ?? '').toString();
    assert.match(mpdText, /<SegmentURL media="http:\/\/[^"]*&amp;X-Amz-/);
    assert.doesNotMatch(mpdText, /&(?!amp;|lt;|gt;|quot;|apos;)/);

    // 从 HLS master 出发：master → media_N.m3u8（含 EXT-X-MEDIA 引用的音频列表）→ init / 分片
    const fromHls = await crawl(hlsMaster.url);
    for (const [objectPath, item] of fromHls) assert.equal(item.status, 200, objectPath);
    assert.deepEqual(
      [...fromHls.keys()].sort(),
      stored
        .filter((s) => s.key !== 'dash-presign/manifest.mpd')
        .map((s) => `/${privateBucket}/${s.key}`)
        .sort(),
    );
  },
);

test(
  '预签名模式：SegmentTemplate 形式的 DASH 无法签名，上传前报错，桶里不留对象、本地文件保留',
  { skip: ffmpegSkip },
  async (t) => {
    if (skipIfUnavailable(t)) return;
    const files = makeDashTree('dash-template', true);
    await assert.rejects(storeOutputs(files, { taskId: 'tpl', settings: settings() }), {
      message: /^DASH 清单 manifest\.mpd 用 SegmentTemplate.*S3_PUBLIC_BASE_URL/,
    });
    for (const file of files) {
      assert.ok(fs.existsSync(file));
      assert.ok(!(await exists(privateBucket, `dash-template/${path.basename(file)}`)));
    }
    fs.rmSync(path.join(root, 'dash-template'), { recursive: true, force: true });
  },
);

test(
  '公开地址模式：播放列表原样上传（相对引用），按目录结构解析即可播放；SegmentTemplate 也不受影响',
  { skip: ffmpegSkip },
  async (t) => {
    if (skipIfUnavailable(t)) return;
    const hls = makeHlsTree('hls-public', 'fmp4');
    const dash = makeDashTree('dash-public', true);
    const s = settings({ bucket: publicBucket, publicBaseUrl: `${endpoint}/${publicBucket}` });
    for (const files of [hls, dash]) {
      const media = hashMedia(files);
      const originals = new Map(files.map((f) => [path.basename(f), fs.readFileSync(f)]));
      const stored = await storeOutputs(files, { taskId: 'pub', settings: s });
      const entry = stored.find((x) => /\/(master\.m3u8|manifest\.mpd)$/.test(x.key ?? ''));
      assert.ok(entry);
      if (entry.key?.endsWith('.m3u8')) {
        await assertPlayable(entry.url, stored, publicBucket, media, false);
      }
      for (const x of stored) {
        const got = await download(x.url);
        assert.equal(got.status, 200, x.key);
        assert.ok(
          got.body.equals(originals.get(path.posix.basename(x.key ?? '')) ?? Buffer.alloc(0)),
          x.key,
        );
      }
    }
  },
);

test(
  '预签名模式 + S3_KEEP_LOCAL_COPY：本地播放列表不改，仍是相对引用',
  { skip: ffmpegSkip },
  async (t) => {
    if (skipIfUnavailable(t)) return;
    const files = makeHlsTree('hls-keep', 'ts');
    const before = new Map(files.map((f) => [f, fs.readFileSync(f)]));
    const stored = await storeOutputs(files, {
      taskId: 'keep',
      settings: settings({ keepLocalCopy: true }),
    });
    for (const file of files)
      assert.ok(fs.readFileSync(file).equals(before.get(file) ?? Buffer.alloc(0)), file);
    const master = stored.find((x) => x.key === 'hls-keep/master.m3u8');
    assert.ok(master && master.size > (before.get(master.path)?.length ?? 0));
    fs.rmSync(path.join(root, 'hls-keep'), { recursive: true, force: true });
  },
);

test('checkStorage：存储桶可用 / 不存在', async (t) => {
  if (skipIfUnavailable(t)) return;
  assert.deepEqual(await checkStorage({ settings: settings() }), { driver: 's3', ok: true });
  assert.deepEqual(await checkStorage({ settings: settings({ bucket: 'ffsvc-no-such-bucket' }) }), {
    driver: 's3',
    ok: false,
    error: '存储桶 ffsvc-no-such-bucket 不存在',
  });
});
