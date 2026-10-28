# FFmpeg Service

FFmpeg Service 把 FFmpeg 封装成 HTTP 接口，基于 Node.js / TypeScript、Express 和 BullMQ（Redis）。共 58 个操作：

- **转码与剪辑**：格式转换、裁剪片段、拼接（可加转场）、提取音频、转 GIF / WebP、变速、倒放、循环、淡入淡出、删除片段、分段
- **画面**：水印（文字 / 图片）、截图、缩略图、预览雪碧图、批量抽帧、封面、裁剪画面、缩放、横竖屏转换、旋转翻转、画中画、多画面拼接
- **特效与压缩**：区域模糊 / 打码、去水印、调色、降噪锐化、防抖、去掉音轨、按目标大小或质量压缩
- **字幕与合成**：烧录或内嵌字幕、加配乐、音频生成视频、图片幻灯片、多个在线视频合成并加背景音乐
- **音频**：格式转换、响度标准化、降噪、去静音、音量、淡入淡出、变速变调、裁剪、倒放、拼接、混音、波形图、频谱图
- **分析与流媒体**：媒体信息、响度、场景切换、静音、黑屏检测、波形峰值数据、HLS / DASH 切片、图片格式转换

所有接口都支持：上传文件或给链接两种输入方式、异步任务与进度查询（轮询 / SSE）、取消任务、完成回调（HMAC 签名）、多步串联（`/api/pipeline`）、产物存本地或 S3 兼容对象存储。可选 API Key 鉴权，输入链接和回调地址有 SSRF 防护。

- **基础地址**: `http://localhost:9527`
- **线上测试地址**: `http://124.221.157.202:9527`
- **完整接口文档**: [Fmpeg API Documentation.md](Fmpeg%20API%20Documentation.md)（调用约定、任务、回调、串联、每个接口的参数）
- **部署**: [部署指南.md](部署指南.md)
- **机器可读的接口说明**: `GET /api/operations`、`GET /api/openapi.json`（OpenAPI 3.1）

## 快速开始

环境要求：Node.js 24 LTS（版本见 `.nvmrc`）、pnpm 12（由 `package.json` 的 `packageManager` 指定）、FFmpeg（生产镜像为 9.0.2）、Redis。Node 24 自带 corepack，首次使用前执行一次：

```bash
corepack enable
```

如果之前全局装过 pnpm 10，在 Windows 上要先升级到 10.34.5 以上，或者卸载后改用 corepack，否则在本项目里执行任何 pnpm 命令都会报找不到 pnpm。

```bash
# 安装依赖
pnpm install

# 开发模式启动
pnpm dev

# 生产构建 & 启动
pnpm build
pnpm start

# 单元测试
pnpm test
```

本地运行需要一个 Redis，默认连 `redis://localhost:6379`，可以用 `docker run -d -p 127.0.0.1:6379:6379 redis:8.10.2-trixie` 启动。只绑定本机地址：这个 Redis 没有密码，任何能连上它的人都能改任务记录、往队列里塞任务。

仓库里的 `.env.local` 会在本地开发时加载。只有 ffmpeg 不在 PATH 中时，才需要在里面设置 `FFMPEG_PATH`。Windows 上的 FFmpeg 通常没有字体配置，文字水印和字幕默认使用系统里的微软雅黑。

**测试说明**

- 处理类测试会用本机 ffmpeg 现场生成小素材并真实执行，没有 ffmpeg 时自动跳过；CI 里设置 `FFMPEG_REQUIRED=1` 让它直接报错。
- 引擎测试需要 Redis，默认连 `redis://localhost:6379/15`（只读写自己前缀的 key，不清库），可用 `TEST_REDIS_URL` 指定别的实例。
- 对象存储测试需要 MinIO，默认连 `http://127.0.0.1:9000`（`MINIO_TEST_ENDPOINT`），连不上时跳过。

## 调用示例

```bash
# 1. 提交任务：上传文件
curl -X POST http://localhost:9527/api/video/crop -F "file=@input.mp4" -F "aspect=9:16"
# {"success":true,"data":{"taskId":"3b5c9f0e-…","status":"pending"}}

#    或者给链接，并在完成后回调
curl -X POST http://localhost:9527/api/video/crop \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/input.mp4", "aspect": "9:16", "callbackUrl": "https://example.com/hooks/ffmpeg"}'

# 2. 查询进度（也可以订阅 SSE：GET /api/tasks/<taskId>/progress）
curl http://localhost:9527/api/tasks/<taskId>

# 3. 完成后按 primaryUrl / downloadUrl 下载
curl -O http://localhost:9527/api/files/<文件名>.mp4

# 多步串联：裁剪片段 → 竖屏 → 切成 HLS
curl -X POST http://localhost:9527/api/pipeline -F "file=@input.mp4" \
  -F 'steps=[{"op":"trim","params":{"startTime":0,"duration":30}},{"op":"video.reframe","params":{"aspect":"9:16"}},{"op":"video.hls"}]'
```

## 接口一览

点击接口地址查看参数。「串联」表示可以作为 `/api/pipeline` 的中间步骤。

<!-- BEGIN GENERATED: operation-index -->
**基础接口（兼容旧版）**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/info`](Fmpeg%20API%20Documentation.md#op-info) | 获取媒体信息（同步） |  |
| [`/api/transcode`](Fmpeg%20API%20Documentation.md#op-transcode) | 转码 / 格式转换 | ✓ |
| [`/api/edit/trim`](Fmpeg%20API%20Documentation.md#op-trim) | 裁剪片段 | ✓ |
| [`/api/edit/extract-audio`](Fmpeg%20API%20Documentation.md#op-extract-audio) | 提取音频 | ✓ |
| [`/api/process/gif`](Fmpeg%20API%20Documentation.md#op-gif) | 视频转动图 | ✓ |

**截图、水印与合成**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/process/watermark`](Fmpeg%20API%20Documentation.md#op-watermark) | 添加水印 | ✓ |
| [`/api/process/screenshot`](Fmpeg%20API%20Documentation.md#op-screenshot) | 视频截图 |  |
| [`/api/process/thumbnail`](Fmpeg%20API%20Documentation.md#op-thumbnail) | 生成缩略图 |  |
| [`/api/compose`](Fmpeg%20API%20Documentation.md#op-compose) | 视频合成（拼接 + 背景音乐） |  |
| [`/api/video/sprite`](Fmpeg%20API%20Documentation.md#op-video-sprite) | 进度条预览雪碧图 |  |
| [`/api/video/frames`](Fmpeg%20API%20Documentation.md#op-video-frames) | 批量抽帧 |  |
| [`/api/video/cover`](Fmpeg%20API%20Documentation.md#op-video-cover) | 智能封面 | ✓ |

**画面尺寸与布局**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/video/crop`](Fmpeg%20API%20Documentation.md#op-video-crop) | 裁剪画面 | ✓ |
| [`/api/video/resize`](Fmpeg%20API%20Documentation.md#op-video-resize) | 缩放画面 | ✓ |
| [`/api/video/reframe`](Fmpeg%20API%20Documentation.md#op-video-reframe) | 改画幅（横转竖） | ✓ |
| [`/api/video/rotate`](Fmpeg%20API%20Documentation.md#op-video-rotate) | 旋转 / 翻转 | ✓ |
| [`/api/video/pip`](Fmpeg%20API%20Documentation.md#op-video-pip) | 画中画 | ✓ |
| [`/api/video/stack`](Fmpeg%20API%20Documentation.md#op-video-stack) | 多画面拼接 |  |

**时间线剪辑**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/edit/merge`](Fmpeg%20API%20Documentation.md#op-merge) | 视频拼接 |  |
| [`/api/video/speed`](Fmpeg%20API%20Documentation.md#op-video-speed) | 视频变速 | ✓ |
| [`/api/video/reverse`](Fmpeg%20API%20Documentation.md#op-video-reverse) | 视频倒放 | ✓ |
| [`/api/video/loop`](Fmpeg%20API%20Documentation.md#op-video-loop) | 循环播放 | ✓ |
| [`/api/video/fade`](Fmpeg%20API%20Documentation.md#op-video-fade) | 淡入淡出 | ✓ |
| [`/api/video/cut`](Fmpeg%20API%20Documentation.md#op-video-cut) | 多段剪切 | ✓ |
| [`/api/video/split`](Fmpeg%20API%20Documentation.md#op-video-split) | 分割视频 |  |

**画面特效与压缩**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/video/blur`](Fmpeg%20API%20Documentation.md#op-video-blur) | 区域模糊 / 马赛克 | ✓ |
| [`/api/video/delogo`](Fmpeg%20API%20Documentation.md#op-video-delogo) | 去水印 | ✓ |
| [`/api/video/color`](Fmpeg%20API%20Documentation.md#op-video-color) | 调色 / 滤镜 | ✓ |
| [`/api/video/enhance`](Fmpeg%20API%20Documentation.md#op-video-enhance) | 画质增强 | ✓ |
| [`/api/video/stabilize`](Fmpeg%20API%20Documentation.md#op-video-stabilize) | 视频防抖 | ✓ |
| [`/api/video/mute`](Fmpeg%20API%20Documentation.md#op-video-mute) | 去除音轨 | ✓ |
| [`/api/video/compress`](Fmpeg%20API%20Documentation.md#op-video-compress) | 视频压缩 | ✓ |

**字幕、配乐与生成视频**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/video/subtitles`](Fmpeg%20API%20Documentation.md#op-video-subtitles) | 添加字幕 | ✓ |
| [`/api/video/mix-audio`](Fmpeg%20API%20Documentation.md#op-video-mix-audio) | 添加 / 替换音频 | ✓ |
| [`/api/video/from-audio`](Fmpeg%20API%20Documentation.md#op-video-from-audio) | 音频转视频 | ✓ |
| [`/api/video/slideshow`](Fmpeg%20API%20Documentation.md#op-video-slideshow) | 图片幻灯片 |  |

**音频处理**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/audio/convert`](Fmpeg%20API%20Documentation.md#op-audio-convert) | 音频格式转换 | ✓ |
| [`/api/audio/normalize`](Fmpeg%20API%20Documentation.md#op-audio-normalize) | 响度标准化 | ✓ |
| [`/api/video/normalize-audio`](Fmpeg%20API%20Documentation.md#op-video-normalize-audio) | 视频响度标准化 | ✓ |
| [`/api/audio/denoise`](Fmpeg%20API%20Documentation.md#op-audio-denoise) | 音频降噪 | ✓ |
| [`/api/audio/trim-silence`](Fmpeg%20API%20Documentation.md#op-audio-trim-silence) | 去除静音 | ✓ |
| [`/api/audio/volume`](Fmpeg%20API%20Documentation.md#op-audio-volume) | 调整音量 | ✓ |
| [`/api/audio/fade`](Fmpeg%20API%20Documentation.md#op-audio-fade) | 音频淡入淡出 | ✓ |
| [`/api/audio/speed`](Fmpeg%20API%20Documentation.md#op-audio-speed) | 变速 / 变调 | ✓ |
| [`/api/audio/trim`](Fmpeg%20API%20Documentation.md#op-audio-trim) | 音频裁剪 | ✓ |
| [`/api/audio/reverse`](Fmpeg%20API%20Documentation.md#op-audio-reverse) | 音频倒放 | ✓ |
| [`/api/audio/concat`](Fmpeg%20API%20Documentation.md#op-audio-concat) | 音频拼接 |  |
| [`/api/audio/mix`](Fmpeg%20API%20Documentation.md#op-audio-mix) | 多轨混音 |  |
| [`/api/audio/waveform`](Fmpeg%20API%20Documentation.md#op-audio-waveform) | 波形图 | ✓ |
| [`/api/audio/spectrogram`](Fmpeg%20API%20Documentation.md#op-audio-spectrogram) | 频谱图 | ✓ |

**分析、流媒体与图片**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/analyze/loudness`](Fmpeg%20API%20Documentation.md#op-analyze-loudness) | 响度分析 |  |
| [`/api/analyze/scenes`](Fmpeg%20API%20Documentation.md#op-analyze-scenes) | 场景切换检测 |  |
| [`/api/analyze/silence`](Fmpeg%20API%20Documentation.md#op-analyze-silence) | 静音检测 |  |
| [`/api/analyze/black`](Fmpeg%20API%20Documentation.md#op-analyze-black) | 黑场检测 |  |
| [`/api/analyze/peaks`](Fmpeg%20API%20Documentation.md#op-analyze-peaks) | 波形峰值 |  |
| [`/api/video/hls`](Fmpeg%20API%20Documentation.md#op-video-hls) | HLS 多码率切片 |  |
| [`/api/video/dash`](Fmpeg%20API%20Documentation.md#op-video-dash) | DASH 多码率切片 |  |
| [`/api/image/convert`](Fmpeg%20API%20Documentation.md#op-image-convert) | 图片格式转换 | ✓ |
<!-- END GENERATED: operation-index -->

平台接口：`GET /api/health`（健康检查）、`GET /api/tasks/:id`（任务详情）、`GET /api/tasks/:id/progress`（SSE 进度）、`POST /api/tasks/:id/cancel` / `DELETE /api/tasks/:id`（取消）、`POST /api/pipeline`（多步串联）、`GET /api/operations`、`GET /api/openapi.json`、`GET /api/files/*`（下载产物）。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `9527` |
| `REDIS_URL` | Redis 连接地址，Docker 部署用 `redis://redis:6379` | `redis://localhost:6379` |
| `MAX_CONCURRENT_TASKS` | 最大并发任务数，2 核 2 G 建议设为 `3` | `CPU 核数 - 1` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | FFmpeg / FFprobe 可执行路径 | `ffmpeg` / `ffprobe` |
| `MAX_UPLOAD_MB` | 单个上传文件的大小上限 | `500` |
| `SAVE_OUTPUT_FILE` | 是否保留输出文件，`false` 时下载一次后删除 | `true` |
| `OUTPUT_RETENTION_HOURS` | 本地产物保留多少小时，到期后台清理；`0` 表示永久保留 | `0` |
| `TASK_TTL_SECONDS` | 任务记录在 Redis 中保留的秒数 | `86400` |
| `MAX_QUEUE_LENGTH` | 排队任务数上限，超过后新提交返回 429；`0` 表示不限 | `0` |
| `SYNC_TIMEOUT_SECONDS` | 同步接口（`/api/info`）的最长执行时间，排队等待的时间也算在内 | `60` |
| `SYNC_MAX_CONCURRENCY` | 同步接口同时执行的请求数，超出的排队（最多排它的 8 倍），排满才返回 429；`0` 表示自动 | `0`（max(8, 2 × `MAX_CONCURRENT_TASKS`)） |
| `PUBLIC_BASE_URL` | 服务对外地址（如 `https://media.example.com`），用于在任务详情和回调里给出完整下载地址 | 空（返回 `/api/files/…`） |
| `API_KEYS` | 逗号分隔的 API Key，设置后除健康检查外都要鉴权 | 空（不鉴权） |
| `PROTECT_FILES` | `/api/files` 下载是否也要 API Key | `false` |
| `ALLOW_PRIVATE_URLS` | 是否允许输入链接和回调地址指向内网 / 回环地址 | `false` |
| `WEBHOOK_SECRET` | 回调签名密钥，设置后回调带 `X-FFmpeg-Service-Signature` | 空 |
| `WEBHOOK_RETRIES` | 回调失败后的重试次数 | `3` |
| `WEBHOOK_TIMEOUT_SECONDS` | 单次回调请求的超时 | `10` |
| `DOWNLOAD_CONCURRENCY` | 每个任务同时下载的链接数 | `3` |
| `DOWNLOAD_RETRIES` | 每个链接下载失败后的重试次数 | `3` |
| `DOWNLOAD_IDLE_TIMEOUT_SECONDS` | 下载时连续多少秒收不到数据就判定卡死并重试 | `30` |
| `DOWNLOAD_MAX_MB` | 链接下载的单个文件大小上限 | `1024` |
| `FONT_NAME` / `FONT_FILE` | 文字水印和烧录字幕用的字体名 / 字体文件，设置了 `FONT_FILE` 时优先用它；Docker 镜像里 `FONT_NAME` 为 `Noto Sans CJK SC` | 空 |
| `S3_BUCKET` | 设置后产物上传到 S3 兼容对象存储 | 空（本地存储） |
| `S3_ENDPOINT` / `S3_REGION` | 对象存储地址和区域（R2、MinIO、OSS 需要 endpoint） | 空 / `auto` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 访问密钥；不设时用 AWS 默认凭证链 | 空 |
| `S3_FORCE_PATH_STYLE` | 路径风格访问（MinIO 需要，OSS 不能开） | `false` |
| `S3_PREFIX` | 对象 key 前缀 | 空 |
| `S3_PUBLIC_BASE_URL` | 公开访问地址（公开读的桶或 CDN）；不设时返回预签名链接 | 空 |
| `S3_PRESIGN_EXPIRES_SECONDS` | 预签名链接有效期，最长 7 天 | `604800` |
| `S3_KEEP_LOCAL_COPY` | 上传后是否保留本地副本 | `false` |

各存储服务的配置示例见 [部署指南.md](部署指南.md)。

## 开发：新增一个操作

每个接口都是 `src/operations/<分组>/` 下的一个操作定义，HTTP 处理、排队、进度、存储、回调、取消和串联都由引擎统一完成：

1. 新建文件，用 `defineOperation({...})` 写出接口地址、输入槽、参数 schema（`src/schemas/coerce.ts` 里有数字、时间、颜色等工具，每个字段用 `.meta({ description })` 写中文说明）和 `run(ctx, params)`。
2. `run` 里用 `ctx.probe()` 读取输入信息，用 `ctx.ffmpeg(args, { duration })` 执行命令（自动带进度和取消），产物路径只能用 `ctx.outputPath(ext)` / `ctx.outputDir()` 生成。
3. 用户提供的文字和文件不能直接拼进滤镜参数：写到 `ctx.workDir` 里，在滤镜中只写文件名（ffmpeg 以 workDir 为工作目录运行）。
4. 加到分组的 `index.ts`，在 `test/unit/operations/<分组>/` 写测试（`test/helpers` 里有生成素材和执行操作的工具）。
5. 运行 `pnpm docs:api` 更新接口文档。
