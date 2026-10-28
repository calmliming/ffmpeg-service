# FFmpeg Service 接口文档

## 概述

FFmpeg Service 把 FFmpeg 封装成 HTTP 接口：转码、剪辑、拼接、水印、字幕、画面调整、特效、压缩、音频处理、媒体分析、HLS / DASH 切片等，共 58 个操作。

- **基础地址**: `http://localhost:9527`
- **输入方式**: 每个输入文件都可以上传（`multipart/form-data`），也可以给一个公网链接，由服务下载
- **最大上传文件**: 默认 500 MB（`MAX_UPLOAD_MB`）；链接下载的单个文件默认 1 GB（`DOWNLOAD_MAX_MB`）
- **处理方式**: 除 `/api/info` 外都是异步任务：提交后立即返回 `taskId`，再轮询、订阅 SSE 进度，或通过回调地址接收结果。`/api/info` 同步返回，并发满时排队等待（`SYNC_MAX_CONCURRENCY`）
- **机器可读的接口说明**: `GET /api/operations`（每个操作的输入和参数 JSON Schema）、`GET /api/openapi.json`（OpenAPI 3.1，可导入 Swagger UI、Postman）

本文档前半部分是所有接口共用的约定，后半部分是逐个接口的参数参考（由代码生成，与 `GET /api/operations` 一致）。

---

## 统一响应格式

成功：

```json
{ "success": true, "data": { ... } }
```

失败：

```json
{ "success": false, "error": "中文错误信息" }
```

| HTTP 状态码 | 含义 |
|------|------|
| `400` | 参数错误（最多列出 10 条，每条都写明字段）、缺少或多传了输入文件、同一个输入既上传又给了链接、文件类型不对、链接不合法或指向内网、请求体不是合法的 JSON / multipart |
| `401` | 配置了 `API_KEYS` 但请求没带或带错了 Key |
| `404` | 接口不存在，或任务不存在 / 已过期 |
| `409` | 取消一个已经结束的任务 |
| `413` | 上传文件超过 `MAX_UPLOAD_MB`、JSON 请求体超过 100 KB、表单字段过多；同步接口链接下载的文件超过 `DOWNLOAD_MAX_MB` |
| `415` | 请求体使用了不支持的 Content-Encoding，只支持 gzip 和 deflate |
| `422` | `/api/info` 收到的文件是空的或无法解析（不是音视频、已损坏） |
| `429` | 排队的任务数达到 `MAX_QUEUE_LENGTH`；或同步接口排队已满、等到超时也没轮到。稍后重试 |
| `499` | 客户端中途断开了上传 |
| `500` | 处理异常，`error` 为具体原因 |
| `502` | 同步接口下载链接时对方返回 5xx 或网络失败（对方返回 4xx 时是 400） |
| `503` | Redis 不可用（约 5 秒内返回，不会一直挂着），或链接的域名暂时解析不了，稍后重试 |
| `504` | 同步接口（`/api/info`）超过 `SYNC_TIMEOUT_SECONDS` |

错误信息里不会出现服务器上的目录，只保留文件名。

---

## 提交任务

所有操作都是 `POST <接口地址>`。

### 输入文件：上传或给链接

每个操作有一个或几个输入「槽」，例如加水印有 `file`（视频）和 `image`（水印图片）。每个槽二选一：

- **上传**：`multipart/form-data`，字段名就是槽名，例如 `-F file=@in.mp4`。多文件槽重复同一个字段：`-F files=@a.mp4 -F files=@b.mp4`。
- **给链接**：JSON 或表单字段里放 http(s) 地址，由服务下载。
  - 单文件槽用 `<槽名>Url`，多文件槽用 `<槽名>Urls`；名为 `file` 的槽也接受 `url`。
  - 值可以是字符串，也可以是字符串数组。
  - 历史接口保留原来的字段名：`/api/compose` 用 `videos` 和 `music`。
  - 每个接口具体接受哪些字段，见下方参数参考里的「输入文件」表，或 `GET /api/operations`。

同一个槽既上传又给链接会返回 400。缺少必需的输入、多传了文件或用了不接受的文件字段时，错误信息会说明可用的字段，例如 `请上传 file 文件，或提供 url / fileUrl 链接`、`file 最多上传 1 个文件`。上传途中断开连接不影响服务，已写入的半截文件会被删除。

上传的文件按 MIME 类型**或**扩展名判断类别（Go、PHP、curl 上传默认发 `application/octet-stream`，所以也看扩展名）。文件内容能不能处理，由 ffprobe 在执行时判断，与扩展名无关。

| 类别 | 接受的文件 |
|---|---|
| 视频 | `video/*` 或常见视频扩展名，以及 GIF |
| 音频 | `audio/*` 或常见音频扩展名 |
| 图片 | `image/*`（不含 SVG），或 `.png` `.jpg` `.webp` `.avif` `.heic` `.apng` 等扩展名 |
| 字幕 | `.srt` `.ass` `.ssa` `.vtt` |
| 视频或音频 | 以上视频、音频 |
| 任意 | 以上全部 |

链接必须是公网地址，详见 [出站链接的安全检查](#出站链接的安全检查)。

### 参数格式

参数可以放在 JSON 请求体里，也可以作为表单字段和文件一起提交。表单里的值都是字符串，服务会按下面的规则转换：

| 类型 | 写法 |
|---|---|
| 数字 | `30`、`"30"`、`"0.5"` |
| 布尔 | `true` / `false`，也接受 `"1"` `"0"` `"yes"` `"no"` `"on"` `"off"` |
| 时间点 / 时长 | 秒数（`10`、`10.5`）或 `[[时:]分:]秒[.毫秒]`（`00:00:10`、`1:02.5`） |
| 颜色 | 颜色名（`white`、`red`）、`#RRGGBB`、`#RRGGBBAA`、`0xRRGGBB`，可带透明度：`white@0.5` |
| 分辨率 | `宽x高`，如 `1280x720` |
| 码率 | `128k`、`2M`、`800000` |
| 列表 | JSON 数组，或重复的表单字段，或逗号分隔的字符串（如 `timestamps=1,2,3`） |

- 空字符串视为没传，使用默认值。
- 不认识的参数会被忽略，不报错。
- 参数不合法时返回 400，信息里带字段名和允许的范围。

### 回调地址 `callbackUrl`

所有异步接口都接受可选的 `callbackUrl`。任务结束（完成、失败或取消）后，服务向这个地址 `POST` 一次结果，详见 [任务回调](#任务回调webhook)。

### 提交后的响应

```json
{ "success": true, "data": { "taskId": "3b5c9f0e-…", "status": "pending" } }
```

### 示例

```bash
# 上传文件
curl -X POST http://localhost:9527/api/transcode -F "file=@input.mov" -F "format=mp4"

# 给链接，并在完成后回调
curl -X POST http://localhost:9527/api/transcode \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/input.mov", "format": "mp4", "callbackUrl": "https://example.com/hooks/ffmpeg"}'
```

---

## 异步任务

### 查询任务

**`GET /api/tasks/:id`**

```json
{
  "success": true,
  "data": {
    "id": "3b5c9f0e-…",
    "type": "transcode",
    "status": "completed",
    "progress": 100,
    "phase": "processing",
    "createdAt": "2026-10-27T08:00:00.000Z",
    "startedAt": "2026-10-27T08:00:01.000Z",
    "completedAt": "2026-10-27T08:00:09.000Z",
    "elapsedSeconds": 8,
    "outputs": [
      {
        "name": "6f1d….mp4",
        "url": "/api/files/6f1d….mp4",
        "size": 1048576,
        "contentType": "video/mp4",
        "storage": "local"
      }
    ],
    "primaryUrl": "/api/files/6f1d….mp4",
    "downloadUrl": ["/api/files/6f1d….mp4"],
    "output": "6f1d….mp4"
  }
}
```

| 字段 | 说明 |
|---|---|
| `id` / `type` | 任务 ID、操作名（如 `transcode`、`video.crop`，串联任务为 `pipeline`） |
| `status` | `pending`（排队中）→ `processing`（处理中）→ `completed` / `failed` / `cancelled`。三个终态都不会再变 |
| `progress` | 0-100 的整数，只增不减 |
| `phase` | 当前阶段：`downloading`（下载链接输入，占前 30%，compose 占 55%）、`analyzing`、`normalizing`、`merging`、`processing`、`encoding`；配置了对象存储时最后是 `uploading`（97-100%）。任务结束后保留最后一个阶段（compose 为 `merging`） |
| `outputs` | 产物列表：`name`（输出目录下的相对路径，HLS 等多文件产物带子目录）、`url`、`size`、`contentType`、`storage`（`local` / `s3`）、`key`（S3 对象 key） |
| `primaryUrl` | 主产物的地址（例如 HLS 的主播放列表） |
| `downloadUrl` | 所有产物地址的数组（旧字段）。本地存储时始终是 `/api/files/…` 相对路径，即使设置了 `PUBLIC_BASE_URL`；完整地址看 `outputs[].url` |
| `result` | 分析类操作的结构化结果（响度、场景、静音区间、波形峰值等） |
| `error` | 失败或取消的原因 |
| `steps` | 串联任务每一步的状态 |
| `currentVideoIndex` / `totalVideos` | compose 和多视频操作的进度：已处理到第几个、共几个 |
| `callbackUrl` / `callback` | 回调地址和投递结果（`delivered`、`attempts`、`status`、`error`、`deliveredAt`、`deliveryId`） |
| `output` | 旧字段：产物在输出目录里的相对路径（与 `outputs[].name` 相同），逗号分隔。新客户端请用 `outputs` |

任务记录默认保留 24 小时（`TASK_TTL_SECONDS`），过期后查询返回 404。

### SSE 实时进度

**`GET /api/tasks/:id/progress`**

返回 `text/event-stream`。先推送一次当前状态，之后每次变化推送一次完整的任务对象，任务进入终态后关闭连接。终态事件之后还有一段只含 `id: <状态>` 的内容（不触发 `onmessage`）：浏览器的 `EventSource` 断开后会自动重连，带着这个 id 重连时服务返回 204，它就不再重连。自己解析事件流时请只处理 `data:` 行。

```javascript
const es = new EventSource('http://localhost:9527/api/tasks/<taskId>/progress');
es.onmessage = (event) => {
  const task = JSON.parse(event.data);
  console.log(task.status, task.progress, task.phase);
  if (['completed', 'failed', 'cancelled'].includes(task.status)) es.close();
};
```

浏览器的 `EventSource` 不能加请求头，开启鉴权时用 `?api_key=<key>`。

### 取消任务

**`POST /api/tasks/:id/cancel`** 或 **`DELETE /api/tasks/:id`**

可选请求体 `{ "reason": "用户取消" }`（最多 200 字，写入任务的 `error` 和回调），默认原因为「任务已取消」。

- 排队中的任务：直接从队列移除，删除已上传的文件。
- 执行中的任务：立即标记为 `cancelled`，并通过 Redis 广播给正在执行的实例（可以是另一台机器），由它结束 FFmpeg 进程、中止下载和上传、删除半成品和临时文件。
- 已经结束的任务：返回 409，`data` 里带当前任务。
- 成功时返回 200，`data` 为任务对象。

```bash
curl -X POST http://localhost:9527/api/tasks/<taskId>/cancel -H "Content-Type: application/json" -d '{"reason":"用户取消"}'
curl -X DELETE http://localhost:9527/api/tasks/<taskId>
```

### 下载产物

产物地址在任务的 `outputs[].url` / `downloadUrl` / `primaryUrl` 里。

- 本地存储时是 `/api/files/<相对路径>`；设置了 `PUBLIC_BASE_URL` 时是完整地址。
- 使用对象存储时是公开地址或预签名链接（见部署指南）。HLS / DASH 这类多文件产物在预签名模式下，播放列表里的引用会被改写成各文件自己的签名链接，可以直接播放，但所有链接在 `S3_PRESIGN_EXPIRES_SECONDS`（默认 7 天）后同时失效；长期分发请设置 `S3_PUBLIC_BASE_URL`。
- `SAVE_OUTPUT_FILE=false` 时，输出目录顶层的文件在第一次完整 `GET` 下载后删除；`HEAD` 请求和中途断开的下载不会触发删除。HLS 分片、批量抽帧等放在子目录里的产物不会被这样删除。
- 设置了 `OUTPUT_RETENTION_HOURS` 时，超过保留时长的产物由后台定时清理。

```bash
curl -O http://localhost:9527/api/files/6f1d….mp4
```

---

## 任务回调（Webhook）

提交任务时带上 `callbackUrl`，任务进入终态后服务向该地址 `POST` 一次 JSON：

```json
{ "event": "task.completed", "task": { "id": "…", "status": "completed", "type": "transcode", "outputs": [ … ], "primaryUrl": "…", "downloadUrl": [ … ] } }
```

`event` 为 `task.completed`、`task.failed` 或 `task.cancelled`，`task` 与 `GET /api/tasks/:id` 返回的相同。

**请求头**

| 请求头 | 说明 |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `ffmpeg-service/<版本号>` |
| `X-FFmpeg-Service-Event` | 事件名，与请求体里的 `event` 相同 |
| `X-FFmpeg-Service-Delivery` | 本次投递的 UUID，**重试时不变**，接收方用它去重 |
| `X-FFmpeg-Service-Attempt` | 第几次尝试，从 1 开始 |
| `X-FFmpeg-Service-Timestamp` | 发送时的 Unix 时间戳（秒），每次尝试重新生成 |
| `X-FFmpeg-Service-Signature` | 设置了 `WEBHOOK_SECRET` 时才有：`sha256=<hex>`，即 `HMAC-SHA256(secret, timestamp + "." + 原始请求体)` |

**投递与重试**

- 单次请求超时 `WEBHOOK_TIMEOUT_SECONDS`（默认 10 秒）。
- 网络错误、超时、408、425、429、5xx 会重试，最多 `WEBHOOK_RETRIES` 次（默认 3 次）。退避从 1 秒开始翻倍，加随机抖动，单次最多 60 秒；会遵守不超过 60 秒的 `Retry-After`。
- 其他 4xx 不重试。回调**不跟随重定向**，收到 3xx 视为失败。
- 投递结果写入任务的 `callback` 字段。投递在后台进行，不影响任务本身。
- 接收方应尽快返回 2xx，耗时的处理放到自己的队列里。

**校验签名**：必须用收到的原始字节计算，不能把解析后的 JSON 重新序列化；拒绝时间戳偏差超过 5 分钟的请求，防止重放；用常数时间比较。

Node.js（Express）：

```js
import crypto from 'node:crypto';
import express from 'express';

const app = express();
app.post('/hooks/ffmpeg', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.get('X-FFmpeg-Service-Timestamp') ?? '';
  const sig = req.get('X-FFmpeg-Service-Signature') ?? '';
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.sendStatus(401);
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(`${ts}.`).update(req.body).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  const { event, task } = JSON.parse(req.body.toString('utf8'));
  // 用 X-FFmpeg-Service-Delivery 去重后再处理 event / task
  res.sendStatus(204);
});
```

Python（Flask）：

```python
import hashlib, hmac, os, time
from flask import Flask, abort, request

app = Flask(__name__)
SECRET = os.environ["WEBHOOK_SECRET"].encode()

@app.post("/hooks/ffmpeg")
def ffmpeg_hook():
    ts = request.headers.get("X-FFmpeg-Service-Timestamp", "")
    sig = request.headers.get("X-FFmpeg-Service-Signature", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        abort(401)
    raw = request.get_data()  # 原始字节
    expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        abort(401)
    data = request.get_json()
    # 用 X-FFmpeg-Service-Delivery 去重后处理 data["event"] / data["task"]
    return "", 204
```

---

## 多步串联：`POST /api/pipeline`

把一个文件依次交给最多 10 个操作处理，作为一个任务执行（`type` 为 `pipeline`）。每一步的主产物是下一步的 `file` 输入，中间产物不会进入输出目录或对象存储，任务结束时删除。

```bash
# JSON：输入用链接，其他步骤需要的额外输入放在 steps[].inputs
curl -X POST http://localhost:9527/api/pipeline -H "Content-Type: application/json" -d '{
  "url": "https://example.com/in.mp4",
  "callbackUrl": "https://example.com/hooks/ffmpeg",
  "steps": [
    {"op": "trim", "params": {"startTime": 5, "duration": 10}},
    {"op": "video.resize", "params": {"width": 720}},
    {"op": "watermark", "params": {"position": "bottom-right"}, "inputs": {"image": "https://example.com/logo.png"}}
  ]
}'

# multipart：上传文件，steps 作为 JSON 字符串；最后一步可以产出多个文件（如 HLS）
curl -X POST http://localhost:9527/api/pipeline -F "file=@in.mp4" \
  -F 'steps=[{"op":"trim","params":{"startTime":0,"duration":30}},{"op":"video.hls"}]'
```

- 每一步是 `{ op, params?, inputs? }`。`op` 是操作名（见参数参考里的「操作名」），`params` 与单独调用该接口时相同，`inputs` 用链接提供该操作的其他输入槽（如 `video.mix-audio` 的 `audio`、`video.pip` 的 `overlay`）。
- 每一步都必须以单个 `file` 为主输入。同步接口（`info`）和以多个文件为输入的操作（`merge`、`compose`、`video.stack`、`video.slideshow`、`audio.concat`、`audio.mix`）不能用在串联里。
- 中间步骤必须产出一个主文件（参数参考里标注「可在 pipeline 中串联」）；第一步和最后一步不限，所以 HLS / DASH 切片、抽帧、分段、分析类操作可以放在最后一步。
- 提交时逐步校验参数，错误信息带步骤号，例如 `第 2 步（video.resize）: width 必须是…`。
- 所有链接在第一步开始前一次下载完。任务的 `steps` 字段显示每一步的状态，进度按步骤平均分配。失败信息为 `第 N 步（操作名）: 原因`。取消和回调与普通任务相同。

---

## 接口发现与健康检查

- **`GET /api/operations`**、**`GET /api/operations/:name`**：每个操作的接口地址、标题、说明、是否同步、能否串联及在串联中允许的位置、输入槽（类别、是否必填、数量、链接字段名）、参数的 JSON Schema（类型、范围、枚举、默认值、中文说明）、示例和补充说明。
- **`GET /api/openapi.json`**：由操作注册表生成的 OpenAPI 3.1 文档，每个操作都有 `multipart/form-data` 和 `application/json` 两种请求体。可以导入 Swagger UI、Redoc、Postman 或客户端代码生成器。
- **`GET /api/health`**：不需要 API Key。FFmpeg、ffprobe、Redis 或存储不可用（上传 / 输出目录不可写、S3 存储桶访问不了）时返回 503，`error` 说明是哪一项。`data` 包括 `status`、`ffmpeg`、`redis`、`storage`（`local` / `s3`）、`storageStatus`、`operations`（操作数）、`version`、`queue`（`waiting`、`active`、`delayed`、`failed`）、`auth`（`enabled`、`protectFiles`）、`timestamp`。FFmpeg 和存储的检查结果缓存 30 秒，频繁探活不会每次都启动进程或访问对象存储。

---

## 安全

### API Key 鉴权

设置 `API_KEYS=key1,key2`（逗号分隔，可以配多个便于轮换）后，除 `GET /api/health` 外的所有 `/api` 接口都需要 Key。下面三种方式任选一种：

1. `Authorization: Bearer <key>`（推荐）
2. `X-API-Key: <key>`
3. 查询参数 `?api_key=<key>`：只建议给 `EventSource` 用，因为它不能加请求头。查询参数里的 Key 可能出现在代理日志和浏览器历史里（本服务自己的访问日志会把它替换成 `***`）。

- 失败返回 401：`{"success": false, "error": "缺少或无效的 API Key"}`。
- `/api/files` 下载默认不需要 Key（文件名是随机 UUID，下载链接常直接交给浏览器）；设置 `PROTECT_FILES=true` 后也需要。
- 不设置 `API_KEYS` 时不鉴权，服务启动时会打印警告。对公网开放前务必设置。

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:9527/api/tasks/<taskId>
```

### 出站链接的安全检查

服务会访问用户给的链接（输入文件链接和 `callbackUrl`）。为防止被借来访问内网（SSRF），所有出站请求都要通过下面的检查：

- 只允许 `http` / `https`；链接里不能带用户名或密码。
- 拒绝内网和保留地址：回环、私有网段、链路本地（含云服务器元数据地址 `169.254.169.254`）、运营商级 NAT、组播、文档示例网段等，IPv4 和 IPv6 都检查，IPv6 里内嵌的 IPv4 地址也会取出来检查；十进制、十六进制等写法的 IP 先换成标准形式再判断。域名解析出的地址里只要有一个是内网地址就拒绝。
- 检查时机：提交任务时（不合格直接返回 400，信息里不回显域名解析出的内网 IP）、开始下载前、每一次重定向前，以及建立连接时按实际解析结果再检查一次，防止「检查时是公网、连接时变成内网」。
- 下载最多跟随 5 次重定向；回调不跟随重定向。
- 服务和素材都在内网时，设置 `ALLOW_PRIVATE_URLS=true` 放行内网地址（带用户名密码的链接仍然拒绝）。

---

## 接口一览

<!-- BEGIN GENERATED: operation-index -->
**基础接口（兼容旧版）**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/info`](#op-info) | 获取媒体信息（同步） |  |
| [`/api/transcode`](#op-transcode) | 转码 / 格式转换 | ✓ |
| [`/api/edit/trim`](#op-trim) | 裁剪片段 | ✓ |
| [`/api/edit/extract-audio`](#op-extract-audio) | 提取音频 | ✓ |
| [`/api/process/gif`](#op-gif) | 视频转动图 | ✓ |

**截图、水印与合成**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/process/watermark`](#op-watermark) | 添加水印 | ✓ |
| [`/api/process/screenshot`](#op-screenshot) | 视频截图 |  |
| [`/api/process/thumbnail`](#op-thumbnail) | 生成缩略图 |  |
| [`/api/compose`](#op-compose) | 视频合成（拼接 + 背景音乐） |  |
| [`/api/video/sprite`](#op-video-sprite) | 进度条预览雪碧图 |  |
| [`/api/video/frames`](#op-video-frames) | 批量抽帧 |  |
| [`/api/video/cover`](#op-video-cover) | 智能封面 | ✓ |

**画面尺寸与布局**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/video/crop`](#op-video-crop) | 裁剪画面 | ✓ |
| [`/api/video/resize`](#op-video-resize) | 缩放画面 | ✓ |
| [`/api/video/reframe`](#op-video-reframe) | 改画幅（横转竖） | ✓ |
| [`/api/video/rotate`](#op-video-rotate) | 旋转 / 翻转 | ✓ |
| [`/api/video/pip`](#op-video-pip) | 画中画 | ✓ |
| [`/api/video/stack`](#op-video-stack) | 多画面拼接 |  |

**时间线剪辑**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/edit/merge`](#op-merge) | 视频拼接 |  |
| [`/api/video/speed`](#op-video-speed) | 视频变速 | ✓ |
| [`/api/video/reverse`](#op-video-reverse) | 视频倒放 | ✓ |
| [`/api/video/loop`](#op-video-loop) | 循环播放 | ✓ |
| [`/api/video/fade`](#op-video-fade) | 淡入淡出 | ✓ |
| [`/api/video/cut`](#op-video-cut) | 多段剪切 | ✓ |
| [`/api/video/split`](#op-video-split) | 分割视频 |  |

**画面特效与压缩**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/video/blur`](#op-video-blur) | 区域模糊 / 马赛克 | ✓ |
| [`/api/video/delogo`](#op-video-delogo) | 去水印 | ✓ |
| [`/api/video/color`](#op-video-color) | 调色 / 滤镜 | ✓ |
| [`/api/video/enhance`](#op-video-enhance) | 画质增强 | ✓ |
| [`/api/video/stabilize`](#op-video-stabilize) | 视频防抖 | ✓ |
| [`/api/video/mute`](#op-video-mute) | 去除音轨 | ✓ |
| [`/api/video/compress`](#op-video-compress) | 视频压缩 | ✓ |

**字幕、配乐与生成视频**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/video/subtitles`](#op-video-subtitles) | 添加字幕 | ✓ |
| [`/api/video/mix-audio`](#op-video-mix-audio) | 添加 / 替换音频 | ✓ |
| [`/api/video/from-audio`](#op-video-from-audio) | 音频转视频 | ✓ |
| [`/api/video/slideshow`](#op-video-slideshow) | 图片幻灯片 |  |

**音频处理**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/audio/convert`](#op-audio-convert) | 音频格式转换 | ✓ |
| [`/api/audio/normalize`](#op-audio-normalize) | 响度标准化 | ✓ |
| [`/api/video/normalize-audio`](#op-video-normalize-audio) | 视频响度标准化 | ✓ |
| [`/api/audio/denoise`](#op-audio-denoise) | 音频降噪 | ✓ |
| [`/api/audio/trim-silence`](#op-audio-trim-silence) | 去除静音 | ✓ |
| [`/api/audio/volume`](#op-audio-volume) | 调整音量 | ✓ |
| [`/api/audio/fade`](#op-audio-fade) | 音频淡入淡出 | ✓ |
| [`/api/audio/speed`](#op-audio-speed) | 变速 / 变调 | ✓ |
| [`/api/audio/trim`](#op-audio-trim) | 音频裁剪 | ✓ |
| [`/api/audio/reverse`](#op-audio-reverse) | 音频倒放 | ✓ |
| [`/api/audio/concat`](#op-audio-concat) | 音频拼接 |  |
| [`/api/audio/mix`](#op-audio-mix) | 多轨混音 |  |
| [`/api/audio/waveform`](#op-audio-waveform) | 波形图 | ✓ |
| [`/api/audio/spectrogram`](#op-audio-spectrogram) | 频谱图 | ✓ |

**分析、流媒体与图片**

| 接口 | 功能 | 串联 |
| --- | --- | --- |
| [`/api/analyze/loudness`](#op-analyze-loudness) | 响度分析 |  |
| [`/api/analyze/scenes`](#op-analyze-scenes) | 场景切换检测 |  |
| [`/api/analyze/silence`](#op-analyze-silence) | 静音检测 |  |
| [`/api/analyze/black`](#op-analyze-black) | 黑场检测 |  |
| [`/api/analyze/peaks`](#op-analyze-peaks) | 波形峰值 |  |
| [`/api/video/hls`](#op-video-hls) | HLS 多码率切片 |  |
| [`/api/video/dash`](#op-video-dash) | DASH 多码率切片 |  |
| [`/api/image/convert`](#op-image-convert) | 图片格式转换 | ✓ |
<!-- END GENERATED: operation-index -->

---

## 接口参考

以下内容由 `pnpm docs:api` 根据代码生成，请勿手工修改。每个接口的「输入文件」表列出上传字段和改用链接时的字段名，「参数」表列出类型、默认值和取值范围。

<!-- BEGIN GENERATED: operation-reference -->
### 基础接口（兼容旧版）

<a id="op-info"></a>

#### 获取媒体信息

`POST /api/info` · 操作名 `info` · 同步返回结果

同步返回音视频文件的元信息：时长、分辨率、编码、码率、帧率、声道、标签、章节等（ffprobe 结果）。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频、音频或图片 | 是 | 1 个 | `url`、`fileUrl` | 音视频、图片或字幕文件 |

**参数**

无参数。


**说明**

- 同步接口，直接在响应的 data 里返回 { streams, format, chapters }，不创建任务。文件为空或无法解析（不是音视频、已损坏）时返回 422，错误信息不含服务器路径。
- 与旧版（fluent-ffmpeg）保持同样的形状和数值转换：duration、bit_rate、size、sample_rate、nb_frames 这类非负数字字符串转成数字；r_frame_rate（"25/1"）、负数（start_time 为 -0.02 时）和 tags 里的值保持字符串。
- 与旧版的差异：值为 N/A 或 unknown 的字段（如 max_bit_rate、color_space）不再出现；chapters 现在真实返回章节（旧版恒为空数组）；side_data_list 原样保留，其中的 rotation 等字段同时摊平到流上（旧版只有摊平的）；format.filename 只返回文件名，不再暴露服务器路径。

```bash
curl -X POST http://localhost:9527/api/info -F "file=@video.mp4"

# 用 URL 提交
curl -X POST http://localhost:9527/api/info -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4"}'
```

<a id="op-transcode"></a>

#### 转码 / 格式转换

`POST /api/transcode` · 操作名 `transcode` · 异步任务 · 可在 pipeline 中串联

把音视频转换成另一种封装格式或编码，可同时调整分辨率、帧率、码率、质量和音频参数；输出纯音频格式时丢弃画面。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 要转换的视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `format` | 字符串 | 否 | `mp4` | 输出格式，默认 mp4。视频：mp4、mkv、mov、webm、avi、flv、ts、m4v、3gp、ogv、mpg、wmv；纯音频（丢弃画面）：mp3、m4a、aac、wav、flac、ogg、opus，其中 ogg 遇到有画面的输入输出 Ogg 视频（theora + vorbis，同 ogv，兼容旧版）。也接受 mpeg、matroska、asf 等别名 |
| `videoCodec` | 字符串 | 否 |  | 视频编码：h264、h265（hevc）、vp9、vp8、av1、mpeg4、mpeg2video、mpeg1video、theora、wmv2 或 copy（直接复制不重新编码）。也接受 libx264 这类编码器名。默认按格式选择（mp4 为 h264，webm 为 vp9） |
| `audioCodec` | 字符串 | 否 |  | 音频编码：aac、mp3、opus、vorbis、flac、alac、ac3、mp2、pcm_s16le、pcm_s24le、wmav2 或 copy。也接受 libmp3lame 这类编码器名。默认按格式选择（mp4 为 aac，webm 为 opus） |
| `videoBitrate` | 字符串 | 否 |  | 视频码率，如 1000k、2.5M（10k-200M）。不带单位时小于 10000 按 kbps（兼容旧版，1000 即 1000k），否则按 bit/s。单独设置时为平均码率；与 crf 同时设置时作为码率上限 |
| `audioBitrate` | 字符串 | 否 |  | 音频码率，如 128k（不带单位的规则同 videoBitrate，128 即 128k）。默认 aac / mp3 / ac3 / mp2 为 192k，opus 为 128k；无损编码忽略 |
| `resolution` | 任意 | 否 |  | 输出分辨率：1280x720（按 fit 适配）、1280x?（宽 1280，高按比例）、?x720 或 50%。每边不超过 7680，奇数自动取偶数 |
| `fit` | 字符串 | 否 |  | resolution 为 宽x高 时画面比例不一致的处理：contain（默认，完整显示并补边）、cover（铺满并裁掉多余部分）、stretch（拉伸变形） |
| `padColor` | 字符串 | 否 |  | fit=contain 时补边的颜色，默认 black；支持颜色名、#RRGGBB |
| `fps` | 数字 | 否 |  | 输出帧率，1-120，可带小数（如 29.97）。默认保持原帧率。范围 1 ~ 120 |
| `crf` | 整数 | 否 |  | 恒定质量，越小画质越好文件越大。h264 / h265 为 0-51（默认 23 / 28），vp9 / av1 为 0-63（默认 31 / 35），vp8 为 4-63。范围 0 ~ 63 |
| `preset` | 字符串 | 否 |  | 编码速度：ultrafast、superfast、veryfast（默认）、faster、fast、medium、slow、slower、veryslow。越慢压缩率越高；vp8 / vp9 / av1 自动换算成各自的速度档位 |
| `noAudio` | 布尔 | 否 | `false` | 去掉音轨，只输出画面，默认 false |
| `sampleRate` | 整数 | 否 |  | 音频采样率（Hz），如 44100、48000。默认保持原采样率（编码器不支持时自动换算）。范围 8000 ~ 192000 |
| `channels` | 整数 | 否 |  | 声道数：1（单声道）或 2（立体声）。默认保持原声道。范围 1 ~ 2 |
| `stripMetadata` | 布尔 | 否 | `false` | 去掉标题、拍摄时间、GPS 位置等元数据和章节，默认 false（保留） |

**说明**

- format 只接受白名单里的格式（旧版直接拼进文件名，存在路径穿越），大小写和开头的点会被忽略；mpeg→mpg、matroska→mkv 等别名自动换算。
- 各格式允许的编码：mp4 = h264 / hevc / av1 / vp9 / mpeg4 + aac / mp3 / opus / flac / alac / ac3；mov = h264 / hevc / mpeg4 + aac / mp3 / alac / ac3 / pcm；m4v = h264 / hevc / mpeg4 + aac / alac / ac3；3gp = h264 / mpeg4 + aac；mkv = 全部；webm = vp9 / vp8 / av1 + opus / vorbis；avi = h264 / mpeg4 + mp3 / aac / ac3 / mp2 / pcm_s16le；flv = h264 + aac / mp3；ts = h264 / hevc / mpeg2video + aac / mp3 / mp2 / ac3 / opus；ogv = theora / vp8 + vorbis / opus / flac；mpg = mpeg2video / mpeg1video + mp2 / mp3 / ac3；wmv = wmv2 + wmav2。纯音频：mp3 = mp3，m4a = aac / alac，aac = aac，wav = pcm_s16le / pcm_s24le，flac = flac，ogg = vorbis / opus / flac，opus = opus。组合不合法时返回 400。
- 默认编码：mp4 / mov / m4v / 3gp / mkv / flv / ts 为 h264 + aac，avi 为 h264 + mp3，webm 为 vp9 + opus，ogv 为 theora + vorbis，mpg 为 mpeg2video + mp2，wmv 为 wmv2（WMV8）+ wmav2。默认质量 h264 crf 23、h265 crf 28、vp9 crf 31、av1 crf 35，preset 为 veryfast。
- format=ogg 与旧版一致：输入有画面时输出 Ogg 视频（theora + vorbis，编码规则和可用参数同 ogv，扩展名仍是 .ogg）；输入只有音频时输出 vorbis 音频。只想从视频里取出 ogg 音频请用 /api/edit/extract-audio。
- wmv 输出 ASF 封装（旧版的 wmv 输出同样是 ASF），wmav2 最高 48 kHz、2 声道，源超出时自动降到 48 kHz / 立体声；asf 是 wmv 的别名。
- 重新编码的画面统一输出 8 bit yuv420p（10 bit / 4:4:4 源也一样），保证浏览器和手机能播放；mp4 / mov 里的 HEVC 带 hvc1 标签，Apple 设备可直接播放。
- 只保留第一路画面（不含封面图）和第一路音轨，字幕、数据流、附件不保留。
- resolution 为 宽x高 时默认 fit=contain（等比缩放后补黑边）。旧版按 fluent-ffmpeg 的行为把像素拉到目标尺寸并靠像素宽高比保持显示比例，现在输出总是方形像素。按比例缩放（1280x?、?x720、50%）基于显示比例计算，竖拍视频的旋转元数据会先应用。
- videoBitrate / audioBitrate 不带单位时，小于 10000 按 kbps 理解（旧版经 fluent-ffmpeg 自动补 k，videoBitrate=1000 即 1000k），否则按 bit/s；k / M 单位照常。
- av1 单独设置 videoBitrate 时按码率上限处理（crf 35 + maxrate），SVT-AV1 的平均码率模式在短视频上偏差很大。
- mpeg2video / mpeg1video 只支持标准帧率（23.976、24、25、29.97、30、50、59.94、60），源帧率不标准时自动换成最接近的标准值。
- videoCodec=copy / audioCodec=copy 时先按上表检查源编码能否放进目标格式，不能时任务失败并给出原因；表外的编码（ProRes、DTS 等）交给 FFmpeg 尝试。
- stripMetadata=true 时去掉全局和流级元数据（标题、创建时间、GPS 等）、章节和 encoder 标签；画面旋转信息不受影响。
- flv 里的 mp3 只能是 11025 / 22050 / 44100 Hz，源采样率不符时自动换成 44100。

```bash
curl -X POST http://localhost:9527/api/transcode \
  -F "file=@video.mp4" -F "format=webm" -F "resolution=1280x?" -F "crf=32"

# 用 URL 提交
curl -X POST http://localhost:9527/api/transcode -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mov","format":"mp4","videoCodec":"h265","preset":"medium"}'
```

<a id="op-trim"></a>

#### 裁剪片段

`POST /api/edit/trim` · 操作名 `trim` · 异步任务 · 可在 pipeline 中串联

按时间截取音视频的一段。默认重新编码、精确到帧；accurate=false 时直接复制流，速度快但起点对齐关键帧。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 要裁剪的视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `startTime` | 数字 | 是 |  | 起始时间：秒数（5、12.5）或 HH:MM:SS[.mmm]（00:00:05）。最小 0 |
| `endTime` | 数字 | 否 |  | 结束时间（绝对时间点），格式同 startTime，必须大于 startTime；同时给了 duration 时以 endTime 为准。最小 0 |
| `duration` | 数字 | 否 |  | 截取时长：秒数或 HH:MM:SS。endTime 和 duration 都不给时截到结尾。最小 0 |
| `accurate` | 布尔 | 否 | `true` | true（默认）重新编码，精确到帧；false 直接复制流，速度很快且无损，但起点会落在前一个关键帧上 |
| `crf` | 整数 | 否 |  | accurate=true 时的画质（h264 / h265 为 0-51，vp9 / av1 为 0-63），默认 h264 23。范围 0 ~ 63 |
| `preset` | 字符串 | 否 |  | accurate=true 时的编码速度，ultrafast … veryslow，默认 veryfast。可选 `ultrafast` / `superfast` / `veryfast` / `faster` / `fast` / `medium` / `slow` / `slower` / `veryslow` |

**说明**

- 时间格式：秒数（5、12.5）或 [[HH:]MM:]SS[.mmm]（00:00:05、1:30、0:00:01.500）。
- endTime 是绝对时间点、duration 是长度；两者都给时以 endTime 为准（与旧版一致），都不给时截到结尾。endTime 超过媒体时长时截到结尾；startTime 不小于媒体时长时任务失败。
- accurate=true（默认）重新编码：沿用源编码（h264 → h264、hevc → h265、vp9 → vp9…，源编码不在支持列表时换成该容器的默认编码），音频码率沿用源码率。accurate=false 用流复制：几乎瞬间完成且无损，但起点落在前一个关键帧，MP4 输出靠 edit list 从指定时间开始播放，其它容器可能多出开头的几帧到几秒。FLAC 音频在流复制时也重新编码（无损），否则文件头里的总时长仍是原文件的。
- 输出格式与输入相同（按 ffprobe 识别，不看扩展名）。输入是其它格式（如 wmv / asf、mxf）时：重新编码输出 mp4（纯音频输出 m4a）；流复制按编码挑能装下的容器（mp4，装不下时 mkv；纯音频按编码选 mp3 / m4a / ogg / opus / flac / wav）。
- 只保留第一路画面和第一路音轨。
- MPEG-TS / MPEG-PS（.ts、.mts、.m2ts、.mpg、.vob）没有关键帧索引，直接跳转会落在关键帧之后：先找起点之前的关键帧再从那里解码，结果同样精确到帧；找不到可用的关键帧时从头解码（长文件会慢一些，流复制则沿用直接跳转）。起点在画面范围内、但截取结果没有画面时任务失败，不会只返回声音。

```bash
curl -X POST http://localhost:9527/api/edit/trim \
  -F "file=@video.mp4" -F "startTime=00:00:05" -F "duration=10"

# 用 URL 提交，快速裁剪（不重新编码）
curl -X POST http://localhost:9527/api/edit/trim -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","startTime":"1:30","endTime":"2:00","accurate":false}'
```

<a id="op-extract-audio"></a>

#### 提取音频

`POST /api/edit/extract-audio` · 操作名 `extract-audio` · 异步任务 · 可在 pipeline 中串联

从视频（或其他音频）中提取一路音轨，输出为 mp3、aac、m4a、wav、flac、ogg 或 opus。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 带音轨的视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `format` | 字符串 | 否 | `mp3` | 音频格式，默认 mp3。可选 mp3、m4a、aac、wav、flac、ogg、opus |
| `bitrate` | 字符串 | 否 |  | 音频码率，如 128k、320k（不带单位时小于 10000 按 kbps，128 即 128k）。默认 mp3 / aac / m4a 为 192k，opus 为 128k；wav / flac 是无损格式，忽略此参数 |
| `sampleRate` | 整数 | 否 |  | 采样率（Hz），如 44100、48000。默认保持原采样率（格式不支持时自动换算）。范围 8000 ~ 192000 |
| `channels` | 整数 | 否 |  | 声道数：1（单声道）或 2（立体声），默认保持原声道。范围 1 ~ 2 |
| `track` | 整数 | 否 | `0` | 提取第几路音轨（从 0 开始），多语言视频可以选择配音，默认 0。范围 0 ~ 63 |
| `copy` | 布尔 | 否 | `false` | 直接复制音频流、不重新编码（无损且很快），要求源音频编码与目标格式一致（如 aac 源提取为 m4a / aac）；默认 false |

**说明**

- 编码：mp3 = libmp3lame，aac（ADTS 裸流）/ m4a = aac，wav = pcm_s16le，flac = flac，ogg = vorbis，opus = libopus。
- copy=true 时源编码必须与格式对应：aac → aac / m4a，mp3 → mp3，opus → opus / ogg，vorbis / flac → ogg，flac → flac，pcm_s16le / pcm_s24le → wav，alac → m4a；不对应时任务失败。
- 采样率按编码器限制校验：mp3 最高 48000，opus 只支持 8000 / 12000 / 16000 / 24000 / 48000。
- 输入没有音轨时任务失败（输入文件没有音轨）；track 超出音轨数量时同样失败并提示实际数量。
- 保留标题、歌手等全局元数据，不保留封面图。

```bash
curl -X POST http://localhost:9527/api/edit/extract-audio \
  -F "file=@video.mp4" -F "format=wav" -F "sampleRate=16000" -F "channels=1"

# 用 URL 提交，不重新编码直接取出 AAC 音轨
curl -X POST http://localhost:9527/api/edit/extract-audio -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","format":"m4a","copy":true}'
```

<a id="op-gif"></a>

#### 视频转动图

`POST /api/process/gif` · 操作名 `gif` · 异步任务 · 可在 pipeline 中串联

把视频的一段转换成 GIF、动态 WebP 或 APNG 动图；GIF 默认使用全局调色板，色彩还原明显好于直接转换。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `startTime` | 数字 | 否 |  | 起始时间：秒数或 HH:MM:SS（如 00:00:02），默认从头开始。最小 0 |
| `duration` | 数字 | 否 |  | 截取时长（秒或 HH:MM:SS），最长 60 秒；不填时转到视频结尾，超过 60 秒只取前 60 秒。最小 0 |
| `width` | 整数 | 否 | `320` | 动图宽度（像素），16-1280，默认 320，高度按比例。范围 16 ~ 1280 |
| `fps` | 数字 | 否 | `10` | 帧率，默认 10。gif 最高 50，webp / apng 最高 60。范围 1 ~ 60 |
| `format` | 字符串 | 否 | `gif` | 输出格式：gif（默认）、webp（动态 WebP，体积小得多）、apng（动态 PNG，无损、体积大） |
| `loop` | 整数 | 否 | `0` | 播放次数：0（默认）无限循环，1 只播一次，N 播 N 次。范围 0 ~ 65535 |
| `palette` | 布尔 | 否 | `true` | 仅 gif：先为整段画面生成 256 色调色板再转换（画质好得多，多解码一遍），默认 true |
| `dither` | 字符串 | 否 |  | 仅 gif 且 palette=true：抖动算法，sierra2_4a、floyd_steinberg、bayer、sierra2、sierra3、burkes、atkinson、none，默认 sierra2_4a。none 体积最小但有色带 |
| `maxColors` | 整数 | 否 |  | 仅 gif 且 palette=true：调色板颜色数 2-256，默认 256；颜色越少文件越小。范围 2 ~ 256 |
| `quality` | 整数 | 否 |  | 仅 webp：有损压缩质量 0-100，默认 75。范围 0 ~ 100 |

**说明**

- 上限：时长 60 秒、宽度 1280（旧版不限）。不填 duration 时转到视频结尾，视频更长时只取前 60 秒。
- GIF 的帧间隔以 1/100 秒计，帧率最高 50，能整除 100 的帧率（10、20、25、50）播放最均匀。
- palette=true（默认）分两遍：第一遍为整段画面生成调色板，第二遍按调色板抖动输出，内存占用与时长无关。palette=false 与旧版行为一致（直接转换，色带明显）。
- apng 输出的扩展名是 .png（APNG 兼容 PNG，不支持动画的看图软件显示第一帧）。dither、maxColors 只对 gif 有效，quality 只对 webp 有效。
- 高度按显示宽高比计算（考虑非方形像素和旋转元数据），最高 2560（1280 宽的 9:16 竖屏刚好 2276），超出时任务失败并提示减小 width。输出不含音频。
- 起点按画面流的时长判断；起点落在最后一帧的显示区间里时从最后一帧开始，片段至少包含一帧（单帧的源输出单帧动图）。
- MPEG-TS / MPEG-PS（.ts、.mts、.m2ts、.mpg）输入先找起点之前的关键帧再解码，起始画面与请求的时间一致。

```bash
curl -X POST http://localhost:9527/api/process/gif \
  -F "file=@video.mp4" -F "startTime=00:00:02" -F "duration=5" -F "width=480" -F "fps=15"

# 用 URL 提交，输出只播一次的动态 WebP
curl -X POST http://localhost:9527/api/process/gif -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","format":"webp","duration":3,"loop":1}'
```

### 截图、水印与合成

<a id="op-watermark"></a>

#### 添加水印

`POST /api/process/watermark` · 操作名 `watermark` · 异步任务 · 可在 pipeline 中串联

给视频加文字水印、图片水印，或两者同时加。支持九宫格位置、透明度、背景框、描边、阴影、出现时间段，以及跑马灯滚动和防盗录反弹效果。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要加水印的视频 |
| `image` | 图片 | 否 | 1 个 | `imageUrl` | 图片水印（png 可带透明通道），与 text 至少提供一个 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | 字符串 | 否 |  | 文字水印内容，支持中文和换行（与 image 至少提供一个）。最长 500 字符 |
| `position` | 字符串 | 否 | `bottom-right` | 水印位置：top-left、top-center、top-right、center-left、center、center-right、bottom-left、bottom-center、bottom-right，默认 bottom-right |
| `imagePosition` | 字符串 | 否 |  | 同时有文字和图片时图片的位置，默认与 position 相同。可选 `top-left` / `top-center` / `top-right` / `center-left` / `center` / `center-right` / `bottom-left` / `bottom-center` / `bottom-right` |
| `margin` | 整数 | 否 | `10` | 水印距画面边缘的距离（像素），默认 10。范围 0 ~ 2000 |
| `fontSize` | 数字 | 否 | `24` | 文字大小（像素），默认 24。范围 4 ~ 1000 |
| `fontColor` | 字符串 | 否 | `white` | 文字颜色：颜色名、#RRGGBB 或 #RRGGBBAA，可带 @透明度，默认 white |
| `boxColor` | 字符串 | 否 |  | 文字背景框颜色，如 black@0.5；不传则没有背景框 |
| `boxPadding` | 整数 | 否 |  | 背景框内边距（像素），默认为字号的 30%。范围 0 ~ 200 |
| `borderWidth` | 整数 | 否 | `0` | 文字描边宽度（像素），默认 0 不描边。范围 0 ~ 20 |
| `borderColor` | 字符串 | 否 | `black` | 文字描边颜色，默认 black |
| `shadowColor` | 字符串 | 否 |  | 文字阴影颜色，如 black@0.6；不传则没有阴影 |
| `shadowOffset` | 整数 | 否 | `2` | 文字阴影向右下的偏移（像素），默认 2。范围 1 ~ 50 |
| `opacity` | 数字 | 否 | `1` | 水印不透明度 0-1，同时作用于文字和图片，默认 1。范围 0 ~ 1 |
| `imageWidth` | 整数 | 否 |  | 图片水印缩放到的宽度（像素），高度等比；不传保持原尺寸。范围 2 ~ 7680 |
| `imageScale` | 数字 | 否 |  | 图片水印宽度占视频宽度的比例（0.01-1），如 0.15；与 imageWidth 二选一。范围 0.01 ~ 1 |
| `startTime` | 数字 | 否 |  | 水印开始出现的时间（秒或 HH:MM:SS），默认从头开始。最小 0 |
| `endTime` | 数字 | 否 |  | 水印消失的时间（秒或 HH:MM:SS），默认持续到结尾。最小 0 |
| `motion` | 字符串 | 否 | `none` | 水印运动方式：none 固定；scroll 从右向左循环滚动（跑马灯，垂直位置取 position）；bounce 在画面内来回反弹（防盗录） |
| `speed` | 数字 | 否 | `100` | scroll / bounce 的移动速度（像素/秒），默认 100。范围 1 ~ 5000 |

**说明**

- text 和 image 至少提供一个；两者都有时同时绘制，图片位置可用 imagePosition 单独指定，避免和文字重叠
- text 最多 500 个字符，可以换行；内容按原样绘制，% 等字符不会被当成模板
- 文字使用服务配置的字体（FONT_FILE / FONT_NAME），Docker 镜像自带中文字体
- fontColor、boxColor 等颜色只接受颜色名、#RRGGBB、#RRGGBBAA，可带 @透明度
- 画面重新编码为 H.264（CRF 23）；音轨能直接放进 mp4 时原样复制，否则转为 AAC 192k。输出 mp4，索引在文件头
- startTime / endTime 控制水印出现的时间段；scroll / bounce 的运动从 startTime 开始计时
- 水印图片本身和缩放后的尺寸都不能超过 7680 像素一边、总像素 7680x4320；动图（gif 等）只播放一遍后停在最后一帧，输出时长始终与原视频一致
- 变形宽银幕（像素不是正方形）的视频先按显示比例拉正，输出为正方形像素，水印不会被拉伸；imageScale、margin 都按显示尺寸计算
- 有多条音轨时只保留第一条（与旧版一致）；字幕轨、数据轨不保留
- 与旧版的区别：旧版同时传 text 和 image 时只画文字，现在两者都画

```bash
# 文字水印（中文、半透明背景框）
curl -X POST http://localhost:9527/api/process/watermark \
  -F "file=@video.mp4" \
  -F "text=© 我的频道" \
  -F "position=top-right" \
  -F "fontSize=36" \
  -F "fontColor=yellow" \
  -F "boxColor=black@0.4"

# 图片水印：宽度占视频 15%，半透明，只在 5-20 秒出现
curl -X POST http://localhost:9527/api/process/watermark \
  -F "file=@video.mp4" \
  -F "image=@logo.png" \
  -F "imageScale=0.15" \
  -F "opacity=0.6" \
  -F "startTime=5" -F "endTime=20"

# 用 URL 提交，文字在画面里反弹移动
curl -X POST http://localhost:9527/api/process/watermark \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","text":"仅供内部预览","motion":"bounce","opacity":0.5}'
```

<a id="op-screenshot"></a>

#### 视频截图

`POST /api/process/screenshot` · 操作名 `screenshot` · 异步任务

在指定的时间点截取视频画面，每个时间点输出一张图片，顺序与请求一致。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `timestamps` | 任意 | 是 |  | 截图时间点，逗号分隔或数组；每项可以是秒数（12.5）、HH:MM:SS（00:01:05）或百分比（50%），最多 50 个 |
| `format` | 字符串 | 否 | `png` | 图片格式：png（无损）、jpg、webp，默认 png |
| `quality` | 整数 | 否 | `90` | 图片质量 1-100，越大越清晰、文件越大，默认 90；只对 jpg 和 webp 生效。范围 1 ~ 100 |
| `width` | 整数 | 否 |  | 截图宽度（像素），高度按比例；不传则为原始分辨率。范围 16 ~ 7680 |

**说明**

- 最多 50 个时间点，可以重复；时间点超出视频画面时长时任务失败并说明原因
- 时间点正好等于时长（或 100%）时取最后一帧
- 截图是精确到帧的（取时间点处或之后的第一帧）：先跳到前一个关键帧再解码到目标时间，长视频也很快；MPEG-TS（.ts / .mts / .m2ts）等没有索引的容器先跳到目标之前再精确选帧，比 mp4 稍慢
- 每个时间点一个独立文件（随机文件名，与旧版一样直接放在输出目录），files 的顺序与请求一致；result.data.frames 给出每张图对应的时间和文件名
- 变形宽银幕（像素不是正方形）的视频会先按显示比例拉正；手机竖拍视频按旋转后的方向输出
- width 为 16-7680；按比例算出的高度也不能超过 7680，总像素不超过 7680x4320

```bash
curl -X POST http://localhost:9527/api/process/screenshot \
  -F "file=@video.mp4" \
  -F "timestamps=00:00:02,5.5,50%" \
  -F "format=jpg" \
  -F "width=640"

# 用 URL 提交
curl -X POST http://localhost:9527/api/process/screenshot \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","timestamps":["00:00:02","00:00:05"]}'
```

<a id="op-thumbnail"></a>

#### 生成缩略图

`POST /api/process/thumbnail` · 操作名 `thumbnail` · 异步任务

从视频中均匀截取多张缩略图，缩放到统一尺寸。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `count` | 整数 | 否 | `6` | 缩略图数量 1-50，默认 6。范围 1 ~ 50 |
| `size` | 对象 | 否 | `{"width":320,"height":240}` | 缩略图尺寸 宽x高，默认 320x240；只给一边（320x? 或 ?x240）时另一边按比例；也可以是原尺寸的百分比（如 50%） |
| `fit` | 字符串 | 否 | `stretch` | 画面比例与 size 不一致时的处理：stretch 拉伸填满（默认，与旧版一致）、contain 完整显示并补边、cover 填满并裁掉多余部分 |
| `padColor` | 字符串 | 否 | `black` | fit=contain 时补边的颜色，默认 black；png / webp 可用 black@0 得到透明边 |
| `format` | 字符串 | 否 | `png` | 图片格式：png（无损）、jpg、webp，默认 png |
| `quality` | 整数 | 否 | `90` | 图片质量 1-100，越大越清晰、文件越大，默认 90；只对 jpg 和 webp 生效。范围 1 ~ 100 |

**说明**

- 最多 50 张；第 i 张取在视频时长的 i/(count+1) 处，避开开头和结尾（与旧版 fluent-ffmpeg 行为一致）
- 每边 16-7680 像素，总像素不超过 7680x4320；只给一边或用百分比时，按视频比例算出的另一边也受这个上限约束
- size 的写法与旧版（fluent-ffmpeg）相同：640x360、640x?、?x360、50%
- 每张缩略图一个独立文件（随机文件名，与旧版一样直接放在输出目录），files 按时间先后排列；result.data.frames 给出每张图对应的时间和文件名
- 每张取在对应时间点处或之后的第一帧；MPEG-TS（.ts / .mts / .m2ts）等没有索引的容器同样精确

```bash
curl -X POST http://localhost:9527/api/process/thumbnail \
  -F "file=@video.mp4" \
  -F "count=8" \
  -F "size=640x360" \
  -F "fit=cover" \
  -F "format=jpg"
```

<a id="op-compose"></a>

#### 视频合成（拼接 + 背景音乐）

`POST /api/compose` · 操作名 `compose` · 异步任务

把多个视频按顺序拼接成一个 mp4，可叠加背景音乐。参数一致时直接流复制，不一致时先统一转码再拼接。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `videos` | 视频 | 是 | 1 ~ 100 个 | `videos` | 要拼接的视频，按顺序 1-100 个；可上传多个 videos 文件，或用 videos 传 URL 数组 |
| `music` | 音频 | 否 | 1 个 | `music` | 背景音乐，可上传文件或用 music 传 URL |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `musicVolume` | 数字 | 否 | `1` | 背景音乐音量 0-1，默认 1。范围 0 ~ 1 |
| `muteOriginalAudio` | 布尔 | 否 | `false` | 是否消除视频原声，只保留背景音乐，默认 false |

**说明**

- 最多 100 个视频；URL 输入先带重试地下载到本地，下载阶段占进度的 55%
- 所有片段的编码、分辨率、帧率和音轨参数一致时直接流复制拼接，速度最快
- 参数不一致时，先把每个片段统一转码成第 1 个视频的分辨率和帧率（等比缩放、黑边补齐），缺音轨的片段补静音，再拼接
- 手机竖拍等带旋转信息、或像素宽高比不是 1:1 的片段，与其他片段不一致时会先统一转码并自动转正；统一转码的画布取第 1 个视频实际显示的宽高
- 默认原声与背景音乐混合：原声保持原音量，背景音乐按 musicVolume 缩放，混合后自动限幅防止爆音
- muteOriginalAudio=true 只保留背景音乐；同时不传 music 时输出无声视频
- 输出时长以视频总时长为准：音乐不够长时补静音，音乐过长时截断
- 任务详情的 phase 依次为 downloading（仅 URL 输入）→ processing（探测片段，很短）→ normalizing（仅参数不一致时）→ merging；currentVideoIndex / totalVideos 表示正在处理第几个片段
- 片段里不能有纯音频文件；背景音乐必须包含音轨，否则任务失败并指出是第几个文件

```bash
curl -X POST http://localhost:9527/api/compose \
  -H "Content-Type: application/json" \
  -d '{
    "videos": [
      "https://example.com/video1.mp4",
      "https://example.com/video2.mp4"
    ],
    "music": "https://example.com/bgm.mp3",
    "musicVolume": 0.8
  }'

# 也可以直接上传文件
curl -X POST http://localhost:9527/api/compose \
  -F "videos=@part1.mp4" -F "videos=@part2.mp4" \
  -F "music=@bgm.mp3" -F "muteOriginalAudio=true"
```

<a id="op-video-sprite"></a>

#### 进度条预览雪碧图

`POST /api/video/sprite` · 操作名 `video.sprite` · 异步任务

按固定间隔截取缩略图拼成雪碧图，并生成 WebVTT 缩略图轨道，可直接用于 Video.js、Plyr、JW Player 等播放器的进度条悬停预览。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `interval` | 数字 | 否 |  | 相邻缩略图间隔（秒）；不传时自动取 时长/100，限制在 1-60 秒（与 count 二选一）。范围 0.1 ~ 3600 |
| `count` | 整数 | 否 |  | 缩略图总数 1-1000，在整个视频上均匀分布（与 interval 二选一）。范围 1 ~ 1000 |
| `columns` | 整数 | 否 | `10` | 每行缩略图数 1-20，默认 10。范围 1 ~ 20 |
| `rows` | 整数 | 否 | `10` | 每张雪碧图最多几行 1-30，默认 10；超过就拆成多张图。范围 1 ~ 30 |
| `thumbWidth` | 整数 | 否 | `160` | 单个缩略图宽度 40-640 像素，默认 160。范围 40 ~ 640 |
| `thumbHeight` | 整数 | 否 |  | 单个缩略图高度 20-720 像素；不传时按视频比例计算。范围 20 ~ 720 |
| `format` | 字符串 | 否 | `jpg` | 雪碧图格式：jpg（默认）、png、webp |
| `quality` | 整数 | 否 | `80` | 图片质量 1-100，越大越清晰、文件越大，默认 80；只对 jpg 和 webp 生效。范围 1 ~ 100 |

**说明**

- 最多 1000 张缩略图；指定的 interval 会超过上限时任务失败，自动间隔时会自动放大间隔
- 每张雪碧图宽 columns × thumbWidth 不超过 7680 像素，高度不超过 4320 像素（缩略图很高时自动减少每张的行数）
- 产物是一个目录：thumbnails.vtt（主产物）和 sprite-1.jpg、sprite-2.jpg……，vtt 里用相对文件名加 #xywh=x,y,w,h 引用，三者放在同一路径下即可直接使用
- result.data 给出 interval、columns、rows（每张最多行数）、thumbWidth、thumbHeight、count（缩略图总数）、sheets（雪碧图文件名）
- 间隔不小于 5 秒时逐张跳转截取，长视频也很快；间隔更小时整段解码一遍。每个缩略图是对应 VTT 时间段开头处或之后的第一帧

```bash
curl -X POST http://localhost:9527/api/video/sprite \
  -F "file=@video.mp4" \
  -F "interval=5" \
  -F "columns=10" \
  -F "thumbWidth=160"

# 用 URL 提交，固定生成 100 张缩略图
curl -X POST http://localhost:9527/api/video/sprite \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","count":100,"format":"webp"}'
```

<a id="op-video-frames"></a>

#### 批量抽帧

`POST /api/video/frames` · 操作名 `video.frames` · 异步任务

按帧率、固定间隔或总数从视频（或其中一段）中批量抽取画面，输出一组图片。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `fps` | 数字 | 否 |  | 每秒抽几帧（0.001-120），如 1 表示每秒一帧；fps、interval、count 三选一，都不传时为 1。范围 0.001 ~ 120 |
| `interval` | 数字 | 否 |  | 每隔多少秒抽一帧（0.01-3600）。范围 0.01 ~ 3600 |
| `count` | 整数 | 否 |  | 在时间范围内均匀抽取的帧数 1-500。范围 1 ~ 500 |
| `startTime` | 数字 | 否 |  | 开始时间（秒或 HH:MM:SS），默认 0。最小 0 |
| `endTime` | 数字 | 否 |  | 结束时间（秒或 HH:MM:SS），默认到视频结尾。最小 0 |
| `width` | 整数 | 否 |  | 图片宽度（像素），高度按比例；不传则为原始分辨率。范围 16 ~ 7680 |
| `format` | 字符串 | 否 | `jpg` | 图片格式：png（无损）、jpg、webp，默认 jpg |
| `quality` | 整数 | 否 | `90` | 图片质量 1-100，越大越清晰、文件越大，默认 90；只对 jpg 和 webp 生效。范围 1 ~ 100 |

**说明**

- 最多 500 帧：按 fps / interval 计算出的帧数超过上限时任务失败，请降低 fps、增大 interval 或缩短时间范围
- fps / interval 模式从 startTime 开始取第一帧；count 模式把时间范围等分成 count 段，取每段的中点
- 每张图是 result.data.frames[].time 处或之后的第一帧；MPEG-TS（.ts / .mts / .m2ts）等没有索引的容器同样精确
- count 超过时间范围内的实际帧数时按实际帧数输出，result.data.count 是实际张数
- width 为 16-7680；按比例算出的高度也不能超过 7680，总像素不超过 7680x4320
- 产物放在同一个目录，文件名 frame-0001.jpg、frame-0002.jpg……；result.data.frames 给出每张图对应的时间
- 间隔不小于 5 秒时逐帧跳转截取，长视频也很快；间隔更小时整段解码一遍

```bash
# 第 10-40 秒每 2 秒一帧，缩放到 480 宽
curl -X POST http://localhost:9527/api/video/frames \
  -F "file=@video.mp4" \
  -F "interval=2" \
  -F "startTime=10" -F "endTime=40" \
  -F "width=480"

# 用 URL 提交，整个视频均匀抽 20 帧
curl -X POST http://localhost:9527/api/video/frames \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","count":20,"format":"webp"}'
```

<a id="op-video-cover"></a>

#### 智能封面

`POST /api/video/cover` · 操作名 `video.cover` · 异步任务 · 可在 pipeline 中串联

用 FFmpeg 的 thumbnail 滤镜在视频（或开头一段）里挑出最有代表性的一帧作为封面，避开黑场和转场。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `startTime` | 数字 | 否 |  | 从第几秒开始挑选（秒或 HH:MM:SS），可跳过片头，默认 0。最小 0 |
| `within` | 数字 | 否 |  | 只在 startTime 之后的多少秒内挑选（1-86400），默认到视频结尾。范围 1 ~ 86400 |
| `width` | 整数 | 否 |  | 封面宽度（像素），高度按比例；不传则为原始分辨率。范围 16 ~ 7680 |
| `format` | 字符串 | 否 | `jpg` | 图片格式：png（无损）、jpg、webp，默认 jpg |
| `quality` | 整数 | 否 | `90` | 图片质量 1-100，越大越清晰、文件越大，默认 90；只对 jpg 和 webp 生效。范围 1 ~ 100 |

**说明**

- 在分析范围内均匀取约 200 个候选帧，选颜色分布最接近整体平均的一帧，再按原始分辨率截取
- 分析范围超过 300 秒时只解码关键帧，长视频也很快
- result.data.time 是选中画面的时间（秒）
- 画面太短（不足两帧）时直接取 startTime 处的画面
- width 为 16-7680；按比例算出的高度也不能超过 7680，总像素不超过 7680x4320

```bash
curl -X POST http://localhost:9527/api/video/cover \
  -F "file=@video.mp4" \
  -F "startTime=3" \
  -F "within=60" \
  -F "width=1280"

# 用 URL 提交
curl -X POST http://localhost:9527/api/video/cover \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","format":"webp"}'
```

### 画面尺寸与布局

<a id="op-video-crop"></a>

#### 裁剪画面

`POST /api/video/crop` · 操作名 `video.crop` · 异步任务 · 可在 pipeline 中串联

按像素区域（x、y、width、height）或按比例（aspect，如 9:16）裁剪视频画面，音轨原样保留。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要裁剪的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `x` | 整数 | 否 |  | 裁剪区域左上角的横坐标（像素），和 y 一起使用；不传时按 anchor 摆放。范围 0 ~ 8192 |
| `y` | 整数 | 否 |  | 裁剪区域左上角的纵坐标（像素），和 x 一起使用。范围 0 ~ 8192 |
| `width` | 整数 | 否 |  | 裁剪宽度（像素），和 height 一起使用；奇数会向下取偶数。范围 2 ~ 8192 |
| `height` | 整数 | 否 |  | 裁剪高度（像素），和 width 一起使用；奇数会向下取偶数。范围 2 ~ 8192 |
| `aspect` | 字符串 | 否 |  | 按比例裁出最大的区域：16:9、9:16、1:1、4:3、3:4、4:5、21:9。不能和 width / height 同时使用 |
| `anchor` | 字符串 | 否 |  | 没有给 x / y 时裁剪区域的位置：center（居中，默认）、top、bottom、left、right（贴边，另一个方向居中） |

**说明**

- 二选一：width + height（可选 x + y，不给坐标时按 anchor 摆放，默认居中），或 aspect 按比例裁出最大区域。
- 坐标基于播放器里看到的画面：带旋转元数据的手机视频先摆正再裁剪，非方形像素先换算成方形像素。
- 裁剪区域必须完全落在源画面内，否则任务失败并提示源画面尺寸；宽高和坐标会向下取偶数（H.264 yuv420p 的要求），奇数尺寸的源视频（如 641x361）选整幅画面时得到 640x360。
- 裁剪后的画面最大 7680x4320（竖屏 4320x7680），只有超过 8K 的源视频才可能超出。
- 任务结果 result 里返回实际的裁剪区域 { x, y, width, height, sourceWidth, sourceHeight }。
- 画面重新编码为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。

```bash
# 横屏裁成居中的 9:16 竖屏
curl -X POST http://localhost:9527/api/video/crop \
  -F "file=@input.mp4" -F "aspect=9:16"

# 按像素区域裁剪（URL 输入）
curl -X POST http://localhost:9527/api/video/crop \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","x":100,"y":50,"width":640,"height":360}'
```

<a id="op-video-resize"></a>

#### 缩放画面

`POST /api/video/resize` · 操作名 `video.resize` · 异步任务 · 可在 pipeline 中串联

把视频缩放到指定宽高或倍数；同时指定宽高时可选等比补边（fit）、铺满裁切（fill）或拉伸（stretch）。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要缩放的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `width` | 整数 | 否 |  | 目标宽度（像素）。只给 width 时高度按原比例计算。范围 2 ~ 7680 |
| `height` | 整数 | 否 |  | 目标高度（像素）。只给 height 时宽度按原比例计算。范围 2 ~ 7680 |
| `scale` | 数字 | 否 |  | 按倍数缩放（0.01-10，如 0.5 为缩小一半），不能和 width / height 同时使用。范围 0.01 ~ 10 |
| `mode` | 字符串 | 否 | `fit` | 同时给 width 和 height 时的缩放方式：fit（等比缩放到框内，空白处补 padColor，默认）、fill（等比放大铺满后居中裁掉多余部分）、stretch（拉伸到精确尺寸） |
| `padColor` | 字符串 | 否 | `black` | fit 模式补边的颜色，如 black、white、#1E90FF，默认 black |
| `algorithm` | 字符串 | 否 | `bicubic` | 缩放算法：bicubic（默认）、bilinear（更快）、lanczos（更锐利）、area（大幅缩小时更干净）、neighbor（最近邻，像素风放大不糊） |

**说明**

- 三选一：width 和 / 或 height，或 scale 倍数。只给一边时另一边按原比例计算并取偶数。
- mode 和 padColor 只在同时给 width 和 height 时生效；只给一边或用 scale 时总是保持比例。
- 输出最大 7680x4320（竖屏 4320x7680），宽高奇数会向下取偶数（H.264 yuv420p 的要求）。
- 带旋转元数据的手机视频按摆正后的画面计算；非方形像素先换算成方形像素，输出总是方形像素（SAR 1:1）。
- 画面重新编码为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。任务结果 result 里返回 { width, height }。

```bash
# 等比缩放到 1280x720 框内，空白处补黑边
curl -X POST http://localhost:9527/api/video/resize \
  -F "file=@input.mp4" -F "width=1280" -F "height=720" -F "mode=fit"

# 只给宽度，高度按比例；URL 输入
curl -X POST http://localhost:9527/api/video/resize \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","width":720}'
```

<a id="op-video-reframe"></a>

#### 改画幅（横转竖）

`POST /api/video/reframe` · 操作名 `video.reframe` · 异步任务 · 可在 pipeline 中串联

把视频改成另一种画幅（如横屏转 9:16 竖屏）：完整保留原画面，居中放在模糊背景或纯色背景上，不裁掉任何内容。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要改画幅的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `aspect` | 字符串 | 否 |  | 目标比例：16:9、9:16、1:1、4:3、3:4、4:5、21:9。默认分辨率短边 1080（如 9:16 为 1080x1920），可用 shortSide 调整 |
| `size` | 对象 | 否 |  | 目标分辨率 宽x高（如 1080x1920），不能和 aspect 同时使用 |
| `shortSide` | 整数 | 否 |  | 配合 aspect 使用：输出短边像素（144-4320），默认 1080，如 720 得到 720x1280。范围 144 ~ 4320 |
| `background` | 字符串 | 否 | `blur` | 背景：blur（源画面放大铺满后模糊，默认）、color（纯色，颜色由 backgroundColor 指定） |
| `backgroundColor` | 字符串 | 否 | `black` | background=color 时的背景色，默认 black |
| `blur` | 整数 | 否 | `20` | background=blur 时的模糊强度 1-50，默认 20。范围 1 ~ 50 |
| `dim` | 数字 | 否 | `0` | background=blur 时背景压暗的比例 0-0.9，默认 0（不压暗），0.3 让主体更突出。范围 0 ~ 0.9 |
| `upscale` | 布尔 | 否 | `true` | 源画面比目标小时是否放大前景。默认 true（前景放大到贴边）；false 时前景保持原尺寸居中，四周都是背景 |

**说明**

- aspect 和 size 二选一。aspect 的默认分辨率短边为 1080：16:9 → 1920x1080、9:16 → 1080x1920、1:1 → 1080x1080、4:3 → 1440x1080、3:4 → 1080x1440、4:5 → 1080x1350、21:9 → 2520x1080；用 shortSide 改短边。
- 放大行为：默认（upscale=true）前景等比缩放到刚好贴住画布的一边，源分辨率低于目标时会被放大（如 640x360 转 9:16 时前景放大到 1080 宽）；upscale=false 时前景不放大，保持原尺寸居中。想避免放大也可以把 shortSide 设成和源视频相当的值。
- 源比例和目标比例相同时直接缩放，不生成背景。
- 输出最大 7680x4320（竖屏 4320x7680），宽高都是偶数。带旋转元数据的手机视频按摆正后的画面计算。
- 画面重新编码为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。

```bash
# 横屏视频转 9:16 竖屏，模糊背景
curl -X POST http://localhost:9527/api/video/reframe \
  -F "file=@landscape.mp4" -F "aspect=9:16" -F "background=blur"

# 转 1:1 正方形，白色背景，720x720（URL 输入）
curl -X POST http://localhost:9527/api/video/reframe \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","aspect":"1:1","shortSide":720,"background":"color","backgroundColor":"white"}'
```

<a id="op-video-rotate"></a>

#### 旋转 / 翻转

`POST /api/video/rotate` · 操作名 `video.rotate` · 异步任务 · 可在 pipeline 中串联

顺时针旋转 90 / 180 / 270 度、任意角度旋转或镜像翻转视频；也可以只改旋转元数据实现无损秒转。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要旋转的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `angle` | 字符串 | 否 |  | 顺时针旋转 90、180 或 270 度（无损的像素转置，画布随之变化） |
| `degrees` | 数字 | 否 |  | 任意角度旋转（-360 到 360，正数顺时针）。90 的倍数等同于 angle；其他角度会扩大画布并用 fillColor 填充四角。范围 -360 ~ 360 |
| `flip` | 字符串 | 否 | `none` | 镜像翻转：none（默认）、horizontal（左右）、vertical（上下）、both（左右加上下）。和旋转一起用时先旋转再翻转 |
| `fillColor` | 字符串 | 否 | `black` | 任意角度旋转时空白处的颜色，默认 black |
| `expand` | 布尔 | 否 | `true` | 任意角度旋转时是否扩大画布以容纳整个画面。默认 true；false 保持原尺寸，四角会被裁掉 |
| `lossless` | 布尔 | 否 | `false` | 只改旋转 / 镜像元数据、不重新编码（秒级完成、画质无损）。只支持 90 度倍数的旋转和翻转，播放器需支持显示矩阵 |

**说明**

- angle、degrees、flip 至少给一个；angle 和 degrees 不能同时使用。同时给旋转和 flip 时先旋转再翻转。
- 旋转基于播放器里看到的方向：手机拍的带旋转元数据的视频先摆正再旋转，输出不再带旋转元数据，播放器不会重复旋转。
- 任意角度旋转默认扩大画布（expand=true），输出尺寸是旋转后的外接矩形。重新编码的输出上限 7680x4320（竖屏 4320x7680），超出时任务失败；lossless 不受此限制。
- lossless=true 时不重新编码，只写入新的显示矩阵（和原有旋转叠加）和镜像标记，画质无损、速度极快；要求画面编码为 H.264 / H.265 / AV1 / VP9 / MPEG-4，只支持 90 度倍数。浏览器、手机和主流播放器都认显示矩阵，但少数剪辑软件或老播放器会忽略它。原视频自带的镜像标记会被覆盖。
- 重新编码时画面为 H.264，AAC / MP3 音轨直接复制，其他音频编码转为 AAC。

```bash
# 顺时针旋转 90 度
curl -X POST http://localhost:9527/api/video/rotate \
  -F "file=@input.mp4" -F "angle=90"

# 左右镜像
curl -X POST http://localhost:9527/api/video/rotate \
  -F "file=@input.mp4" -F "flip=horizontal"

# 无损旋转（只改元数据，不重新编码；URL 输入）
curl -X POST http://localhost:9527/api/video/rotate \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","angle":270,"lossless":true}'
```

<a id="op-video-pip"></a>

#### 画中画

`POST /api/video/pip` · 操作名 `video.pip` · 异步任务 · 可在 pipeline 中串联

把另一个视频或图片缩小后叠加在主视频的角落或中央，可设置出现时间段、边框、透明度和声音来源。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 主视频（决定输出的尺寸和时长） |
| `overlay` | 视频、音频或图片 | 是 | 1 个 | `overlayUrl` | 小画面素材：视频或图片（png / jpg / webp / gif） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `position` | 字符串 | 否 | `bottom-right` | 小画面位置：top-left、top-right、bottom-left、bottom-right（默认）、center，或贴边居中的 top、bottom、left、right |
| `width` | 数字 | 否 | `0.3` | 小画面宽度占主画面宽度的比例 0.05-0.9，默认 0.3，高度按小画面原比例。范围 0.05 ~ 0.9 |
| `margin` | 整数 | 否 | `20` | 小画面离主画面边缘的距离（像素），默认 20；center 位置忽略。范围 0 ~ 2000 |
| `startTime` | 数字 | 否 |  | 小画面出现的时间（秒或 HH:MM:SS），默认从头开始；视频素材从这一刻开始播放。最小 0 |
| `endTime` | 数字 | 否 |  | 小画面消失的时间（秒或 HH:MM:SS），默认一直显示到主视频结束。最小 0 |
| `audio` | 字符串 | 否 | `main` | 音频：main（只用主视频的声音，默认）、mix（主视频和小画面的声音混合）、overlay（只用小画面的声音） |
| `border` | 整数 | 否 | `0` | 小画面边框宽度（像素），默认 0 不加边框。范围 0 ~ 100 |
| `borderColor` | 字符串 | 否 | `white` | 边框颜色，默认 white |
| `opacity` | 数字 | 否 | `1` | 小画面不透明度 0.05-1，默认 1（完全不透明）。范围 0.05 ~ 1 |
| `loopOverlay` | 布尔 | 否 | `false` | 小画面视频比主视频短时是否循环播放。默认 false：播完后小画面消失；图片素材始终显示 |

**说明**

- 输出的尺寸、帧率和时长都跟主视频一致；小画面视频更长时会被截断。
- 小画面视频从 startTime 开始播放；比主视频短时默认播完消失，loopOverlay=true 时循环播放。图片素材在 startTime 到 endTime 之间一直显示，支持 PNG 透明通道。
- 小画面高度按素材原比例计算；连同边框放不下时自动等比缩小到主画面以内，margin 太大时位置会被夹回画面内；边框宽到放不下小画面时任务失败。
- 主视频画面最大 7680x4320（竖屏 4320x7680），超出时任务失败。
- audio=overlay 要求小画面素材带音轨；audio=mix 时缺音轨的一方会被忽略。小画面的声音同样从 startTime 开始、到 endTime 截止。
- 画面重新编码为 H.264；audio=main 时 AAC / MP3 音轨直接复制，其他情况转为 AAC。

```bash
# 右下角放一个 30% 宽的小画面，带 4 像素白边
curl -X POST http://localhost:9527/api/video/pip \
  -F "file=@main.mp4" -F "overlay=@camera.mp4" \
  -F "position=bottom-right" -F "width=0.3" -F "border=4"

# 第 5-15 秒在左上角显示一张图片（URL 输入）
curl -X POST http://localhost:9527/api/video/pip \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/main.mp4","overlayUrl":"https://example.com/logo.png","position":"top-left","width":0.2,"startTime":5,"endTime":15}'
```

<a id="op-video-stack"></a>

#### 多画面拼接

`POST /api/video/stack` · 操作名 `video.stack` · 异步任务

把 2-9 个视频左右并排、上下排列或排成宫格同屏播放，常用于对比、反应视频和多机位展示。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `files` | 视频 | 是 | 2 ~ 9 个 | `filesUrls`、`urls` | 要拼接的视频，2-9 个，按提交顺序从左到右、从上到下排列。URL 方式用 filesUrls 或 urls 数组 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `layout` | 字符串 | 否 | `horizontal` | 排列方式：horizontal（左右并排，默认）、vertical（上下排列）、grid（宫格，默认列数为 √n 向上取整，如 4 个为 2x2、9 个为 3x3） |
| `columns` | 整数 | 否 |  | grid 布局的列数（1-9），默认自动。范围 1 ~ 9 |
| `height` | 整数 | 否 |  | horizontal：所有画面统一缩放到的高度，默认取最矮的输入；grid：每格的高度。vertical 布局不能使用。范围 2 ~ 7680 |
| `width` | 整数 | 否 |  | vertical：所有画面统一缩放到的宽度，默认取最窄的输入；grid：每格的宽度。horizontal 布局不能使用。范围 2 ~ 7680 |
| `gap` | 整数 | 否 | `0` | 画面之间的间隔（像素，0-200），默认 0；奇数会向上取偶数。范围 0 ~ 200 |
| `gapColor` | 字符串 | 否 | `black` | 间隔、宫格空位和格内留白的颜色，默认 black |
| `audio` | 字符串 | 否 | `first` | 音频：first（第 1 个视频的声音，默认）、mix（所有视频的声音混合）、none（无声） |
| `duration` | 字符串 | 否 | `shortest` | 输出时长：shortest（最短的视频结束时结束，默认）、longest（最长的视频结束时结束，先结束的画面停在最后一帧） |

**说明**

- horizontal 把所有画面等比缩放到同一高度（默认最矮输入的高度），vertical 统一宽度（默认最窄输入的宽度）；grid 每格默认是面积最小的输入的尺寸，画面等比缩放后在格内居中，空位和留白用 gapColor 填充。
- 拼接后的画面最大 7680x4320（竖屏 4320x7680），超出时任务失败，请调小 height / width 或改用 grid。
- 帧率统一为第 1 个视频的帧率。duration=longest 时先结束的画面停在最后一帧。
- gap 为奇数时向上取偶数（如 5 → 6），保证输出宽高是偶数（H.264 yuv420p 的要求）。
- URL 方式提交时视频链接放在 filesUrls（或 urls）数组里。
- audio=first 时第 1 个视频没有音轨则输出无声；audio=mix 把所有带音轨的视频混合（不压低音量，带限幅防爆音）。
- 画面重新编码为 H.264；audio=first 时 AAC / MP3 音轨直接复制，其他情况转为 AAC。

```bash
# 两个视频左右并排，中间 10 像素白色间隔
curl -X POST http://localhost:9527/api/video/stack \
  -F "files=@left.mp4" -F "files=@right.mp4" -F "gap=10" -F "gapColor=white"

# 4 个视频 2x2 宫格，声音混合，按最长的视频输出（URL 输入）
curl -X POST http://localhost:9527/api/video/stack \
  -H "Content-Type: application/json" \
  -d '{"filesUrls":["https://example.com/1.mp4","https://example.com/2.mp4","https://example.com/3.mp4","https://example.com/4.mp4"],"layout":"grid","audio":"mix","duration":"longest"}'
```

### 时间线剪辑

<a id="op-merge"></a>

#### 视频拼接

`POST /api/edit/merge` · 操作名 `merge` · 异步任务

把 2-20 个视频按顺序首尾拼接成一个 MP4，可在片段之间加转场（淡化、擦除、滑动、圆形展开等 50 多种）。分辨率、帧率不同的视频会自动统一。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `files` | 视频 | 是 | 2 ~ 20 个 | `filesUrls`、`videos`、`urls` | 要拼接的视频，按上传或 URL 的顺序拼接，2-20 个 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `transition` | 字符串 数组 | 否 | `[]` | 转场效果：none（默认，直接拼接）或 xfade 转场名，如 fade、dissolve、fadeblack、fadewhite、wipeleft、slideleft、circleopen、radial、pixelize、zoomin。多个用逗号分隔时按顺序用于每个衔接处（不够则循环） |
| `transitionDuration` | 数字 | 否 | `1` | 转场时长（秒），0.1-5，默认 1；必须小于每个视频的时长。范围 0.1 ~ 5 |
| `size` | 对象 | 否 |  | 输出分辨率，如 1280x720，最大 7680x4320（竖屏 4320x7680）。默认使用第 1 个视频的分辨率；指定后所有视频都会转码 |
| `fps` | 数字 | 否 |  | 输出帧率，1-120。默认使用第 1 个视频的帧率；指定后所有视频都会转码。范围 1 ~ 120 |
| `fit` | 字符串 | 否 | `pad` | 画面比例不同时的处理：pad（默认，等比缩放后补边）、crop（等比放大后裁掉多余部分，铺满画面） |
| `background` | 字符串 | 否 | `black` | fit=pad 时补边的颜色，默认 black |

**说明**

- 2-20 个视频，总时长不超过 4 小时；输出始终是 MP4（H.264 + AAC，或原编码流复制）。
- 不加转场时：所有视频编码、分辨率、帧率、音频参数完全一致就直接流复制（秒级完成、画质无损），否则逐个转码成第 1 个视频的参数后再拼接。
- 加转场时：先把每个视频统一成相同的分辨率、帧率和采样率，再用 xfade（画面）+ acrossfade（声音）一次合成。每个转场让总时长减少 transitionDuration 秒。
- 没有音轨的视频会补上静音，保证后面片段的声音不会提前；所有视频都没有声音时输出也没有音轨。
- 分辨率或比例不同的视频按 fit 处理：pad 补边（颜色由 background 指定）、crop 裁切铺满。
- 画面带旋转信息（手机竖拍）的视频按转正后的方向处理：目标分辨率取第 1 个视频转正后的宽高；旋转角度不同的视频不能直接流复制，会先转正再拼接。统一转码时，非方形像素（SAR 不是 1:1）的视频按显示比例缩放。

```bash
curl -X POST http://localhost:9527/api/edit/merge \
  -F "files=@video1.mp4" \
  -F "files=@video2.mp4" \
  -F "files=@video3.mp4" \
  -F "transition=fade" \
  -F "transitionDuration=0.8"

# URL 输入，不同衔接处用不同转场
curl -X POST http://localhost:9527/api/edit/merge \
  -H "Content-Type: application/json" \
  -d '{"filesUrls":["https://example.com/a.mp4","https://example.com/b.mp4","https://example.com/c.mp4"],"transition":"wipeleft,circleopen"}'
```

<a id="op-video-speed"></a>

#### 视频变速

`POST /api/video/speed` · 操作名 `video.speed` · 异步任务 · 可在 pipeline 中串联

把视频或音频加速 / 减速（0.25-4 倍）。默认声音保持原音调，也可以像磁带快放一样连音调一起变；慢放时可选补帧让画面更顺滑。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `factor` | 数字 | 是 |  | 速度倍数，0.25-4。2 表示两倍速（时长减半），0.5 表示慢放一半速度。范围 0.25 ~ 4 |
| `keepPitch` | 布尔 | 否 | `true` | 是否保持音调。true（默认）用 atempo 变速不变调；false 连音调一起变（快放变尖、慢放变低沉） |
| `fps` | 数字 | 否 |  | 输出帧率，1-120。默认沿用原视频帧率（超过 120 时取 120）。范围 1 ~ 120 |
| `interpolation` | 字符串 | 否 | `none` | 慢放补帧方式：none（默认，重复帧）、blend（相邻帧混合，较快）、motion（运动补偿插帧，最顺滑但很慢，仅支持 1080p 及以下） |
| `mute` | 布尔 | 否 | `false` | 是否去掉声音，默认 false |

**说明**

- 画面用 setpts 变速，声音用 atempo 变速；atempo 单级只支持 0.5-2 倍，超出时自动拆成多级串联，音质不受影响。
- 默认输出帧率与原视频相同：加速时丢帧、慢放时重复帧。需要顺滑慢动作时用 interpolation=blend 或 motion。
- interpolation=motion 使用 minterpolate 运动补偿，速度只有实时的几分之一，只允许 1080p 及以下的视频。
- 纯音频文件也可以变速，输出 m4a（AAC）；没有音轨的视频只处理画面。
- 输出时长上限 4 小时（原时长 ÷ factor）。

```bash
curl -X POST http://localhost:9527/api/video/speed \
  -F "file=@video.mp4" \
  -F "factor=2"

# 慢放 0.5 倍并用运动补偿补帧（URL 输入）
curl -X POST http://localhost:9527/api/video/speed \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","factor":0.5,"interpolation":"motion"}'
```

<a id="op-video-reverse"></a>

#### 视频倒放

`POST /api/video/reverse` · 操作名 `video.reverse` · 异步任务 · 可在 pipeline 中串联

把视频（或音频）从尾到头倒着播放。长素材自动分段倒放再拼接，内存占用不随时长增长。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `audio` | 字符串 | 否 | `reverse` | 声音处理：reverse（默认，声音也倒放）、original（画面倒放、声音保持原样正向播放）、mute（去掉声音） |

**说明**

- 总时长上限 10 分钟。
- FFmpeg 的 reverse / areverse 滤镜要把整段素材缓存在内存里，服务按分辨率把素材切成 1-5 秒的小段（4K 约 1 秒、1080p 约 5 秒），逐段倒放后倒序拼接。
- 纯音频文件也可以倒放，输出 m4a（AAC）；audio=original 时画面倒放、原声正向播放。

```bash
curl -X POST http://localhost:9527/api/video/reverse \
  -F "file=@video.mp4" \
  -F "audio=original"
```

<a id="op-video-loop"></a>

#### 循环播放

`POST /api/video/loop` · 操作名 `video.loop` · 异步任务 · 可在 pipeline 中串联

把视频或音频首尾相接重复多次：指定重复次数 times，或指定目标时长 duration（最后一遍在目标时长处截断）。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `times` | 整数 | 否 |  | 重复次数（含原片），2-100 的整数。times 和 duration 二选一，都不填时为 2。范围 2 ~ 100 |
| `duration` | 数字 | 否 |  | 目标总时长，秒数或 HH:MM:SS，最长 1 小时。素材会一直循环直到这个时长，最后一遍在此截断。最小 0 |
| `mode` | 字符串 | 否 | `accurate` | accurate（默认）重新编码，输出统一的 MP4 / M4A；fast 直接流复制，速度快、画质无损，容器按原编码选择（MP4 放不下时为 MKV） |

**说明**

- 输出总时长上限 1 小时（times × 原时长，或 duration）。
- duration 小于原时长时相当于从头截取到该时长。
- 用 concat 列表重复同一个文件，每一遍的起点严格等于原文件时长；accurate 模式会给声音比画面短的素材补静音，不会逐遍累积音画错位。
- mode=fast 不重新编码，截断点落在最近的数据包上；声音明显短于画面的素材用 fast 循环多遍后可能音画不同步，请用 accurate。

```bash
curl -X POST http://localhost:9527/api/video/loop \
  -F "file=@clip.mp4" \
  -F "times=5"

# 循环到 1 分钟，流复制
curl -X POST http://localhost:9527/api/video/loop \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/clip.mp4","duration":60,"mode":"fast"}'
```

<a id="op-video-fade"></a>

#### 淡入淡出

`POST /api/video/fade` · 操作名 `video.fade` · 异步任务 · 可在 pipeline 中串联

给视频开头加淡入、结尾加淡出（从黑场 / 白场或任意颜色渐变），声音同步淡入淡出。纯音频文件只处理声音。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `fadeIn` | 数字 | 否 |  | 开头淡入的秒数，0-60，默认 0（不淡入）。范围 0 ~ 60 |
| `fadeOut` | 数字 | 否 |  | 结尾淡出的秒数，0-60，默认 0（不淡出）。范围 0 ~ 60 |
| `color` | 字符串 | 否 | `black` | 淡入淡出的底色：black（默认）、white，或任意颜色名 / #RRGGBB |
| `audio` | 布尔 | 否 | `true` | 声音是否同步淡入淡出，默认 true；false 时声音原样保留 |
| `audioFadeIn` | 数字 | 否 |  | 声音淡入秒数，默认与 fadeIn 相同。范围 0 ~ 60 |
| `audioFadeOut` | 数字 | 否 |  | 声音淡出秒数，默认与 fadeOut 相同。范围 0 ~ 60 |
| `curve` | 字符串 | 否 | `tri` | 声音淡入淡出曲线：tri（默认，线性）、qsin、hsin、esin、log、ipar、qua、cub、squ、cbr、par、exp |

**说明**

- 每段淡入 / 淡出最长 60 秒，且淡入 + 淡出不能超过素材时长。
- 淡出按画面流和音轨各自的实际时长计算，音画长度不一致的素材也会在各自结尾淡到底。
- 只淡画面时声音直接流复制；只淡声音（fadeIn / fadeOut 为 0、只给 audioFadeIn / audioFadeOut）时画面直接流复制。
- 纯音频文件输出 m4a（AAC），此时 audio 必须为 true。

```bash
curl -X POST http://localhost:9527/api/video/fade \
  -F "file=@video.mp4" \
  -F "fadeIn=1" \
  -F "fadeOut=2" \
  -F "color=white"
```

<a id="op-video-cut"></a>

#### 多段剪切

`POST /api/video/cut` · 操作名 `video.cut` · 异步任务 · 可在 pipeline 中串联

一次删除视频中的多个时间段（如去掉片头、广告、口误），或只保留指定的几段并按时间顺序拼起来。逐帧精确。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `ranges` | 对象 数组 | 是 |  | 时间区间列表。字符串 "10-20,35.5-40" 或 "00:00:10-00:00:20"，也可以传数组（["10-20"]、[[10,20]]、[{"start":10,"end":20}]）；结束省略表示到结尾，如 "35-"。最多 100 个 |
| `mode` | 字符串 | 否 | `remove` | remove（默认）删除这些区间、保留其余部分；keep 只保留这些区间 |

**说明**

- 最多 100 个区间。区间会按时间排序，重叠或相接的区间自动合并；keep 模式也按时间顺序输出，不能调换片段顺序。
- 区间开始时间超出时长、或结束时间超出时长 0.05 秒以上时报错；在误差内的按时长截断。
- 用 trim / atrim + concat 滤镜重新编码，切点逐帧精确；只解码第一段开始到最后一段结束之间的内容。
- 纯音频文件也可以剪切，输出 m4a（AAC）。
- 任务结果 data 里有 kept（保留的片段）、removed（删除的片段）和 duration（输出时长）。

```bash
# 删掉 10-20 秒和 35.5-40 秒
curl -X POST http://localhost:9527/api/video/cut \
  -F "file=@video.mp4" \
  -F "ranges=10-20,35.5-40"

# 只保留两段（URL 输入）
curl -X POST http://localhost:9527/api/video/cut \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","mode":"keep","ranges":[{"start":"00:01:00","end":"00:01:30"},{"start":120,"end":150}]}'
```

<a id="op-video-split"></a>

#### 分割视频

`POST /api/video/split` · 操作名 `video.split` · 异步任务

把一个视频（或音频）切成多个文件：按固定时长、在指定时间点、或平均分成 N 段。可以逐帧精确重新编码，也可以按关键帧快速流复制。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 视频或音频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `segmentDuration` | 数字 | 否 |  | 按固定时长分割，每段秒数（或 HH:MM:SS），最后一段可能更短。最小 0 |
| `timestamps` | 数字 数组 | 否 |  | 在这些时间点切开，逗号分隔或数组，如 10,25.5,00:01:00；最多 99 个。1 ~ 不限 项 |
| `parts` | 整数 | 否 |  | 平均分成几段，2-100。范围 2 ~ 100 |
| `mode` | 字符串 | 否 | `accurate` | accurate（默认）逐段重新编码，切点逐帧精确；fast 流复制，速度快、画质无损，但只能在关键帧处切开，实际切点会推后到下一个关键帧 |

**说明**

- 最多 100 段；segmentDuration、timestamps、parts 三选一。
- 短于 0.1 秒的零头会并进相邻的一段。
- 产物按顺序命名为 part_001、part_002…，放在同一个目录里；任务结果 data.parts 列出每段的 index、start、end、duration 和文件名 file。
- accurate 输出 MP4（纯音频为 M4A）；fast 流复制，容器按原编码选择（H.264 / HEVC + AAC 为 MP4，其他为 MKV 等）。
- fast 模式只能在关键帧切开，关键帧间隔大的视频实际段数可能少于请求的段数，data.parts 给出的是实际起止时间。

```bash
# 每 60 秒切一段
curl -X POST http://localhost:9527/api/video/split \
  -F "file=@video.mp4" \
  -F "segmentDuration=60"

# 在指定时间点快速切开（URL 输入）
curl -X POST http://localhost:9527/api/video/split \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","timestamps":["00:01:00","00:02:30"],"mode":"fast"}'
```

### 画面特效与压缩

<a id="op-video-blur"></a>

#### 区域模糊 / 马赛克

`POST /api/video/blur` · 操作名 `video.blur` · 异步任务 · 可在 pipeline 中串联

对视频中的一个或多个矩形区域做模糊或马赛克处理（人脸、车牌、隐私信息），不指定区域时处理整个画面。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要处理的视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `regions` | 任意 | 否 |  | 要处理的矩形区域，最多 10 个。可写 JSON 数组 [{"x":10,"y":20,"width":200,"height":80}]、[[10,20,200,80]] 或字符串 "10,20,200,80;300,40,120,60"；对象形式还可以带各自的 startTime / endTime。不传则处理整个画面 |
| `unit` | 字符串 | 否 | `px` | 区域坐标单位：px 像素（默认）或 percent（相对画面宽高的百分比 0-100） |
| `mode` | 字符串 | 否 | `blur` | 效果：blur 模糊（默认）或 mosaic 马赛克 |
| `strength` | 数字 | 否 | `30` | 强度 1-100，默认 30。blur 时为模糊半径、mosaic 时为色块边长，按区域短边一半的百分比计算。范围 1 ~ 100 |
| `startTime` | 数字 | 否 |  | 从第几秒开始处理，秒数或 HH:MM:SS；不传则从头开始。最小 0 |
| `endTime` | 数字 | 否 |  | 处理到第几秒，秒数或 HH:MM:SS；不传则到结尾。最小 0 |

**说明**

- 最多 10 个区域；超出画面的部分会被裁掉，完全在画面外的区域返回错误。坐标按旋转后的显示方向计算（手机竖拍视频也一样）。
- 区域坐标会对齐到偶数像素，在画面内的边长至少 4 像素（更小的区域会被扩大到 4 像素）。
- 全局 startTime / endTime 对所有区域生效，对象形式的区域可以用自己的 startTime / endTime 覆盖。
- 画面重新编码为 H.264（CRF 23），音轨原样保留（不兼容 mp4 的音频编码会转为 AAC），输出 mp4；奇数宽高会裁掉 1 像素。

```bash
curl -X POST http://localhost:9527/api/video/blur \
  -F "file=@input.mp4" \
  -F 'regions=[{"x":40,"y":30,"width":160,"height":90},{"x":400,"y":300,"width":120,"height":60,"startTime":2,"endTime":5}]' \
  -F "mode=mosaic" -F "strength=40"

# URL 输入（JSON）
curl -X POST http://localhost:9527/api/video/blur \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","regions":"10,10,30,20","unit":"percent"}'
```

<a id="op-video-delogo"></a>

#### 去水印

`POST /api/video/delogo` · 操作名 `video.delogo` · 异步任务 · 可在 pipeline 中串联

用周围像素插值抹掉视频中固定位置的台标、水印或文字，支持多个区域和按时间段处理。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要处理的视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `x` | 数字 | 否 |  | 水印区域左上角的横坐标。范围 0 ~ 100000 |
| `y` | 数字 | 否 |  | 水印区域左上角的纵坐标。范围 0 ~ 100000 |
| `width` | 数字 | 否 |  | 水印区域的宽度。范围 0.01 ~ 100000 |
| `height` | 数字 | 否 |  | 水印区域的高度。范围 0.01 ~ 100000 |
| `regions` | 任意 | 否 |  | 多个水印区域（最多 10 个），代替 x / y / width / height。写法同 /api/video/blur 的 regions，对象形式可以带各自的 startTime / endTime（适合位置会跳动的水印） |
| `unit` | 字符串 | 否 | `px` | 坐标单位：px 像素（默认）或 percent（相对画面宽高的百分比 0-100） |
| `startTime` | 数字 | 否 |  | 从第几秒开始去水印，秒数或 HH:MM:SS；不传则从头开始。最小 0 |
| `endTime` | 数字 | 否 |  | 去水印到第几秒，秒数或 HH:MM:SS；不传则到结尾。最小 0 |
| `show` | 布尔 | 否 | `false` | 调试用：在处理区域画出绿色边框，方便确认坐标，默认 false |

**说明**

- 用 x / y / width / height 指定一个区域，或用 regions 指定最多 10 个区域，二者选一。
- FFmpeg 的 delogo 要求区域严格在画面内：贴边或超出画面的区域会自动收进 1 像素（最外圈 1 像素无法处理），完全在画面外时返回错误。
- 坐标按旋转后的显示方向计算；不确定坐标时先加 show=true 跑一次，看绿框是否罩住水印。
- 适合静态的小面积水印，大面积或动态水印抹除后会留下明显的模糊块，这种情况可以改用 /api/video/blur。
- 画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。

```bash
curl -X POST http://localhost:9527/api/video/delogo \
  -F "file=@input.mp4" \
  -F "x=20" -F "y=20" -F "width=180" -F "height=60"

# 水印中途换位置：两个区域各自带时间段
curl -X POST http://localhost:9527/api/video/delogo \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","regions":[{"x":10,"y":10,"width":200,"height":60,"endTime":5},{"x":500,"y":900,"width":200,"height":60,"startTime":5}]}'
```

<a id="op-video-color"></a>

#### 调色 / 滤镜

`POST /api/video/color` · 操作名 `video.color` · 异步任务 · 可在 pipeline 中串联

调整视频的亮度、对比度、饱和度、伽马和色相，或套用黑白、复古、暖色等风格预设。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要处理的视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `brightness` | 数字 | 否 |  | 亮度 -1 到 1，0 为不变。范围 -1 ~ 1 |
| `contrast` | 数字 | 否 |  | 对比度 0 到 3，1 为不变。范围 0 ~ 3 |
| `saturation` | 数字 | 否 |  | 饱和度 0 到 3，1 为不变，0 为黑白。范围 0 ~ 3 |
| `gamma` | 数字 | 否 |  | 伽马 0.1 到 10，1 为不变；大于 1 提亮暗部。范围 0.1 ~ 10 |
| `hue` | 数字 | 否 |  | 色相旋转角度 -180 到 180，0 为不变。范围 -180 ~ 180 |
| `preset` | 字符串 | 否 | `none` | 风格预设：none（默认）、grayscale 黑白、sepia 怀旧棕、negate 负片、vintage 复古、warm 暖色、cool 冷色、vivid 鲜艳、crossprocess 交叉冲印、lighter 提亮、darker 压暗、contrast 强对比 |
| `startTime` | 数字 | 否 |  | 从第几秒开始调色，秒数或 HH:MM:SS；不传则从头开始。最小 0 |
| `endTime` | 数字 | 否 |  | 调色到第几秒，秒数或 HH:MM:SS；不传则到结尾。最小 0 |

**说明**

- 至少要有一项调整（非默认值的 brightness / contrast / saturation / gamma / hue，或 preset 不为 none）。
- 先应用 preset，再在预设效果上做亮度、对比度、饱和度、伽马和色相微调。
- startTime / endTime 限定调色生效的时间段，其余时间保持原样。
- 画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。

```bash
curl -X POST http://localhost:9527/api/video/color \
  -F "file=@input.mp4" \
  -F "brightness=0.05" -F "contrast=1.2" -F "saturation=1.3"

# 只把第 3-6 秒变成黑白
curl -X POST http://localhost:9527/api/video/color \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","preset":"grayscale","startTime":3,"endTime":6}'
```

<a id="op-video-enhance"></a>

#### 画质增强

`POST /api/video/enhance` · 操作名 `video.enhance` · 异步任务 · 可在 pipeline 中串联

对视频做降噪、锐化、去隔行和去色带处理，改善手机夜景、老录像等素材的观感。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要处理的视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `denoise` | 字符串 | 否 | `none` | 降噪强度（hqdn3d）：none（默认）、light、medium、strong |
| `sharpen` | 数字 | 否 | `0` | 锐化强度 0-2（unsharp，只锐化亮度），0 为不锐化，常用 0.5-1。范围 0 ~ 2 |
| `deinterlace` | 布尔 | 否 | `false` | 去隔行（bwdif），用于电视录制、老摄像机等隔行扫描素材，默认 false |
| `deband` | 布尔 | 否 | `false` | 去色带：消除天空、渐变背景上压缩造成的条纹，默认 false |

**说明**

- 至少要开启一项：denoise 不为 none、sharpen 大于 0、deinterlace 或 deband。
- 处理顺序固定为：去隔行 → 降噪 → 去色带 → 锐化。
- deinterlace 每帧输出一帧（帧率不变），对逐行素材使用会让画面略微变软。
- 画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。

```bash
curl -X POST http://localhost:9527/api/video/enhance \
  -F "file=@input.mp4" \
  -F "denoise=medium" -F "sharpen=0.8"
```

<a id="op-video-stabilize"></a>

#### 视频防抖

`POST /api/video/stabilize` · 操作名 `video.stabilize` · 异步任务 · 可在 pipeline 中串联

分析镜头抖动并平滑补偿（vid.stab 两遍处理），让手持拍摄的画面更稳定。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要处理的视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `smoothing` | 整数 | 否 | `10` | 平滑程度 1-100，默认 10：用前后各多少帧来平滑镜头运动，越大越稳但跟随越慢。范围 1 ~ 100 |
| `shakiness` | 整数 | 否 | `5` | 原片抖动程度 1-10，默认 5；抖得厉害的素材调高。范围 1 ~ 10 |
| `zoom` | 数字 | 否 | `0` | 额外放大的百分比 0-20，默认 0；用来进一步裁掉边缘的黑边。范围 0 ~ 20 |
| `autoZoom` | 布尔 | 否 | `true` | 自动计算刚好能藏住黑边的固定放大比例（默认 true） |
| `crop` | 字符串 | 否 | `black` | 画面移出后边缘的填充方式：black 黑色（默认）或 keep 沿用上一帧的内容 |
| `tripod` | 布尔 | 否 | `false` | 三脚架模式：把镜头完全固定在第一帧的位置（忽略 smoothing），适合本应静止的机位 |
| `sharpen` | 布尔 | 否 | `true` | 稳定后轻微锐化，抵消变换插值带来的模糊（默认 true） |

**说明**

- 两遍处理：第一遍分析运动（任务 phase 为 analyzing，进度 0-50%），第二遍变换并编码（phase 为 processing，50-100%），耗时约为普通转码的两倍。
- autoZoom 开启时会自动放大到看不见黑边；zoom 在此基础上再额外放大。关闭 autoZoom 时边缘按 crop 的方式填充。
- tripod=true 时镜头锁定在第一帧的位置，smoothing 不再生效；机位本身在移动（走路、平移）的素材不要用。
- 画面重新编码为 H.264（CRF 23），音轨原样保留，输出 mp4。

```bash
curl -X POST http://localhost:9527/api/video/stabilize \
  -F "file=@shaky.mp4" \
  -F "smoothing=20" -F "shakiness=8"
```

<a id="op-video-mute"></a>

#### 去除音轨

`POST /api/video/mute` · 操作名 `video.mute` · 异步任务 · 可在 pipeline 中串联

删除视频里的全部音轨，画面流复制不重新编码，速度快且画质无损。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要处理的视频文件 |

**参数**

无参数。


**说明**

- 画面直接流复制，不重新编码；只保留主画面流，音轨、字幕、封面图和数据流都会去掉。
- 容器尽量保持不变：mp4、mov、mkv、webm 原样输出（matroska 里是 VP8 / VP9 / AV1 时输出 webm）；avi、flv、ts 等其他容器在编码允许时转为 mp4，否则输出 mkv。
- 输入没有音轨时同样成功，相当于只做一次封装转换。

```bash
curl -X POST http://localhost:9527/api/video/mute -F "file=@input.mp4"
```

<a id="op-video-compress"></a>

#### 视频压缩

`POST /api/video/compress` · 操作名 `video.compress` · 异步任务 · 可在 pipeline 中串联

按目标文件大小（两遍编码）或画质档位压缩视频，可同时限制分辨率和帧率、切换 H.265 / VP9 / AV1 编码。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要处理的视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `targetSizeMB` | 数字 | 否 |  | 目标文件大小（MB，按 1024×1024 字节计）。设置后用两遍编码精确控制码率，不能和 quality 同时使用。范围 0.01 ~ 100000 |
| `quality` | 字符串 | 否 |  | 画质档位（CRF）：low 体积最小、medium（默认）、high 画质最好；不设 targetSizeMB 时生效 |
| `codec` | 字符串 | 否 | `h264` | 视频编码：h264（默认，兼容性最好）、h265（同画质约小 40%）、vp9、av1（压缩率最高、编码最慢） |
| `format` | 字符串 | 否 |  | 输出容器：mp4 或 webm。默认 vp9 输出 webm，其余输出 mp4 |
| `maxWidth` | 整数 | 否 |  | 最大宽度（64-7680），超过时按比例缩小，不会放大。范围 64 ~ 7680 |
| `maxHeight` | 整数 | 否 |  | 最大高度（64-7680），超过时按比例缩小，不会放大。范围 64 ~ 7680 |
| `maxFps` | 数字 | 否 |  | 最大帧率（1-120），原片帧率更高时降到这个值。范围 1 ~ 120 |
| `audioBitrate` | 任意 | 否 |  | 音频码率（16k-512k），如 96k、128k。默认 128k，原音轨码率更低时沿用原码率 |
| `removeAudio` | 布尔 | 否 | `false` | 去掉音轨，把全部体积留给画面，默认 false |
| `speed` | 字符串 | 否 | `medium` | 编码速度：fast 最快、medium（默认）、slow 同样体积下画质更好但更慢 |

**说明**

- targetSizeMB 和 quality 二选一，都不传时按 quality=medium 压缩。MB 按 1024×1024 字节计。
- targetSizeMB：视频码率 =（目标大小 − 音频 − 封装开销）÷ 时长，两遍编码；结果超出目标时自动降码率重新做一次两遍编码，保留两次中更小的结果，通常落在目标的 90%-100%。目标大于原文件时码率不超过原文件的平均码率，不会把文件变大。
- quality 模式不保证比原文件小：原片码率已经很低时输出可能更大，这时请改用 targetSizeMB。
- 容器：h264 / h265 / av1 默认 mp4，vp9 默认 webm，也可以用 format 指定；webm 只支持 vp9 和 av1。h265 在 mp4 里打 hvc1 标签，苹果设备可以直接播放。
- 音频：mp4 用 AAC、webm 用 Opus，只保留第一条音轨；默认 128k，原音轨码率更低时沿用原码率。removeAudio=true 去掉音轨。
- 结果 data 包含 originalSize、outputSize（字节）、ratio（输出 / 原始），以及实际使用的编码、分辨率和码率。

```bash
# 压到 20 MB 以内
curl -X POST http://localhost:9527/api/video/compress \
  -F "file=@input.mp4" -F "targetSizeMB=20"

# 720p + H.265 + 低画质档位
curl -X POST http://localhost:9527/api/video/compress \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","quality":"low","codec":"h265","maxWidth":1280,"maxHeight":1280}'
```

### 字幕、配乐与生成视频

<a id="op-video-subtitles"></a>

#### 添加字幕

`POST /api/video/subtitles` · 操作名 `video.subtitles` · 异步任务 · 可在 pipeline 中串联

给视频加字幕：烧录进画面（支持字号、颜色、描边、底框、位置等样式），或封装成可开关的字幕轨。支持 SRT、ASS / SSA、WebVTT。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |
| `subtitle` | 字幕（srt / ass / ssa / vtt） | 否 | 1 个 | `subtitleUrl` | 字幕文件（SRT、ASS / SSA、WebVTT），也可以用 text 参数直接传内容 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `mode` | 字符串 | 否 | `burn` | burn：把字幕烧录进画面（重新编码）；soft：作为可开关的字幕轨封装（画面流复制，很快） |
| `text` | 字符串 | 否 |  | 直接传字幕内容（SRT 或 WebVTT 文本，≤ 60 KB），代替上传 subtitle 文件 |
| `encoding` | 字符串 | 否 | `auto` | 字幕文件编码。auto：按 BOM / UTF-8 / UTF-16 自动识别，都不是时按 GB18030（兼容 GBK）解码。可选 `auto` / `utf-8` / `gb18030` / `big5` / `shift_jis` / `euc-kr` / `windows-1252` / `utf-16le` / `utf-16be` |
| `offset` | 数字 | 否 | `0` | 字幕整体平移的秒数（-3600 到 3600），正数推迟、负数提前；提前到 0 秒之前的字幕丢弃。范围 -3600 ~ 3600 |
| `container` | 字符串 | 否 | `mp4` | 输出容器。soft 模式下 mp4 的字幕轨是 mov_text（会丢失 ASS 样式），mkv 保留原格式 |
| `language` | 字符串 | 否 |  | soft 模式：字幕轨的语言（ISO 639-2，如 chi、eng、jpn） |
| `fontSize` | 数字 | 否 |  | burn 模式：字号，单位是输出画面的像素（文字高度约为字号）。范围 4 ~ 400 |
| `fontColor` | 字符串 | 否 |  | burn 模式：文字颜色，如 white、#FFD700、yellow@0.8 |
| `outlineColor` | 字符串 | 否 |  | burn 模式：描边颜色 |
| `outline` | 数字 | 否 |  | burn 模式：描边宽度（像素，0-10）；设置了 boxColor 时是底框的内边距。范围 0 ~ 10 |
| `shadow` | 数字 | 否 |  | burn 模式：阴影偏移（像素，0-10）。范围 0 ~ 10 |
| `boxColor` | 字符串 | 否 |  | burn 模式：设置后文字下方加底框（如 black@0.6），此时 outlineColor 不生效 |
| `bold` | 布尔 | 否 |  | burn 模式：粗体 |
| `italic` | 布尔 | 否 |  | burn 模式：斜体 |
| `position` | 字符串 | 否 |  | burn 模式：字幕垂直位置，默认 bottom。可选 `bottom` / `top` / `middle` |
| `align` | 字符串 | 否 |  | burn 模式：水平对齐，默认 center。可选 `left` / `center` / `right` |
| `marginV` | 整数 | 否 |  | burn 模式：与画面上 / 下边缘的距离（像素）。范围 0 ~ 4000 |
| `overrideFont` | 布尔 | 否 |  | burn 模式：ASS 字幕也强制使用服务器配置的字体（ASS 里指定的字体服务器上没有、出现方框或空白时打开）。SRT / WebVTT 总是使用服务器字体 |

**说明**

- 字幕格式按内容识别，不看扩展名；非 UTF-8 的字幕自动按 GB18030（兼容 GBK）解码，也可以用 encoding 指定。
- burn 模式重新编码画面（H.264 CRF 23），音轨流复制；soft 模式画面和音轨都流复制（mp4 装不下的编码会转成 H.264 / AAC）。
- burn 模式用服务器配置的字体渲染 SRT / WebVTT，中文可正常显示：设置了 FONT_FILE 时用这个字体文件（与文字水印一致，FONT_NAME 只用来在 .ttc 字体集合里挑一个），否则用 FONT_NAME，Windows 默认微软雅黑；ASS 字幕默认用文件里指定的字体，服务器上没有时打开 overrideFont。
- fontSize、outline、shadow、marginV 都按输出画面像素计算，不受字幕脚本分辨率影响；样式参数只在 burn 模式生效，ASS 字幕只有显式传入的样式才会覆盖原样式。
- soft 模式：mp4 的字幕轨是 mov_text（ASS 样式会丢失，原有字幕轨不保留）；mkv 保留 ASS 样式和原有字幕轨，WebVTT 转成 SRT；原有的 mov_text 字幕（mp4 / mov 输入）转成 SRT，其他 mkv 装不下的字幕轨丢弃并记在任务日志里。
- offset 直接改写字幕文本里的时间轴（burn 和 soft 都适用）：结束时间早于 0 秒的字幕丢弃，跨过 0 秒的从 0 秒开始。
- text 不超过 60 KB，字幕文件不超过 20 MB。

```bash
curl -X POST http://localhost:9527/api/video/subtitles \
  -F "file=@video.mp4" -F "subtitle=@zh.srt" \
  -F "fontSize=40" -F "fontColor=yellow" -F "outline=2" -F "position=bottom"

# URL 输入 + 内嵌字幕文本，封装成软字幕
curl -X POST http://localhost:9527/api/video/subtitles \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","mode":"soft","language":"chi",
       "text":"1\n00:00:00,000 --> 00:00:02,000\n你好，世界\n"}'
```

<a id="op-video-mix-audio"></a>

#### 添加 / 替换音频

`POST /api/video/mix-audio` · 操作名 `video.mix-audio` · 异步任务 · 可在 pipeline 中串联

给视频配上一段音频：与原声混合或替换原声，可调音量、循环、延后开始、淡入淡出，并可在原声说话时自动压低背景音乐。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 视频文件 |
| `audio` | 音频 | 是 | 1 个 | `audioUrl` | 要加入的音频（背景音乐、配音等） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `mode` | 字符串 | 否 | `mix` | mix：与原声混合；replace：替换原声 |
| `volume` | 数字 | 否 | `1` | 加入的音频音量倍数（0-3，1 为原始音量）。范围 0 ~ 3 |
| `originalVolume` | 数字 | 否 | `1` | mix 模式：视频原声的音量倍数（0-3）。范围 0 ~ 3 |
| `loop` | 布尔 | 否 | `false` | 加入的音频比视频短时循环播放 |
| `offset` | 数字 | 否 | `0` | 加入的音频从视频的第几秒开始（秒或 HH:MM:SS）。最小 0 |
| `audioStart` | 数字 | 否 | `0` | 从加入音频的第几秒开始取（跳过前奏等），秒或 HH:MM:SS。最小 0 |
| `fadeIn` | 数字 | 否 | `0` | 加入的音频淡入秒数（0-60）。范围 0 ~ 60 |
| `fadeOut` | 数字 | 否 | `0` | 加入的音频在结束前淡出的秒数（0-60）。范围 0 ~ 60 |
| `ducking` | 布尔 | 否 | `false` | mix 模式：原声有人说话时自动压低加入的音频（侧链压缩，适合给口播配背景音乐） |

**说明**

- 输出时长始终等于视频时长：加入的音频更长时截断，更短时补静音（loop=true 时循环）。
- 画面流复制不重新编码（mp4 装不下的编码会转成 H.264），音频统一编码为 AAC 192k、48 kHz 立体声。
- 视频本身没有音轨时，mix 模式等同 replace，只输出加入的音频。
- 混音不做自动降音量（amix normalize=0），再用限幅器防止爆音；原声和加入音频的音量用 originalVolume / volume 调。
- loop 时第一遍从 audioStart 开始，之后每一遍都从音频开头循环，接缝处无缝衔接（先解码成 PCM 再循环，mp4 / m4a 里 AAC 末尾的补齐静音会裁掉）。fadeOut 作用在加入音频实际结束的位置。

```bash
curl -X POST http://localhost:9527/api/video/mix-audio \
  -F "file=@video.mp4" -F "audio=@bgm.mp3" \
  -F "volume=0.4" -F "loop=true" -F "fadeOut=3" -F "ducking=true"

# URL 输入
curl -X POST http://localhost:9527/api/video/mix-audio \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/video.mp4","audioUrl":"https://example.com/voice.m4a","mode":"replace"}'
```

<a id="op-video-from-audio"></a>

#### 音频转视频

`POST /api/video/from-audio` · 操作名 `video.from-audio` · 异步任务 · 可在 pipeline 中串联

把音频做成视频：静态封面、波形、频谱或频谱柱，也可以在封面图上叠加可视化，常用于把音乐、播客发到视频平台。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频（也可以是带音轨的视频） |
| `image` | 图片 | 否 | 1 个 | `imageUrl` | 封面图；不传时自动使用音频文件内嵌的封面（mp3 / m4a / flac 常见） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `style` | 字符串 | 否 |  | 画面样式。cover：静态封面图；waveform：波形；spectrum：滚动频谱；bars：频谱柱；cover-waveform / cover-spectrum / cover-bars：封面图上叠加对应的可视化。默认有封面图（上传的 image 或音频内嵌封面）时 cover，否则 waveform |
| `size` | 任意 | 否 | `{"width":1280,"height":720}` | 输出分辨率，默认 1280x720，最大 3840x2160（奇数自动减 1） |
| `fps` | 数字 | 否 | `25` | 帧率（1-60），默认 25。范围 1 ~ 60 |
| `waveColor` | 字符串 | 否 | `white` | 波形 / 频谱柱的颜色，默认 white |
| `backgroundColor` | 字符串 | 否 | `black` | 背景色（没有封面图时的底色，以及 fit=contain 的留白），默认 black |
| `waveMode` | 字符串 | 否 | `cline` | 波形画法：cline 居中实心线条、line 竖线、p2p 连线、point 点，默认 cline |
| `spectrumColor` | 字符串 | 否 | `intensity` | spectrum 样式的配色方案，默认 intensity。可选 `channel` / `intensity` / `rainbow` / `moreland` / `nebulae` / `fire` / `fiery` / `fruit` / `cool` / `magma` / `green` / `viridis` / `plasma` / `cividis` / `terrain` |
| `waveHeight` | 数字 | 否 | `0.3` | cover-* 样式：可视化条带占画面高度的比例（0.1-1），默认 0.3。范围 0.1 ~ 1 |
| `wavePosition` | 字符串 | 否 | `bottom` | cover-* 样式：可视化条带的位置，默认 bottom。可选 `bottom` / `center` / `top` |
| `fit` | 字符串 | 否 | `contain` | 图片适配方式。contain：完整显示，空白处填背景色；cover：铺满画面，裁掉多出的部分；blur：完整显示，空白处用放大模糊的同一张图填充 |
| `start` | 数字 | 否 |  | 从音频的第几秒开始（秒或 HH:MM:SS），默认从头。最小 0 |
| `duration` | 数字 | 否 |  | 只取这么长的一段（秒），默认到音频结束。最小 0 |

**说明**

- 输出时长等于音频时长（或 start / duration 截取的那一段），最长 4 小时。
- 输出 H.264 + AAC 的 mp4；AAC 音频且不截取时音轨直接流复制。
- 封面图只解码一次并缩放到输出尺寸，大图不会拖慢编码；动图只取第一帧；图片上限 1 亿像素。
- style=cover-* 但没上传 image 时使用音频内嵌封面，两者都没有时任务失败；waveform / spectrum / bars 不使用图片，上传 image 会被拒绝。
- 分辨率最大 3840x2160，帧率 1-60。

```bash
curl -X POST http://localhost:9527/api/video/from-audio \
  -F "file=@song.mp3" -F "image=@cover.jpg" \
  -F "style=cover-waveform" -F "waveColor=#00D4FF" -F "fit=blur"

# URL 输入，纯波形
curl -X POST http://localhost:9527/api/video/from-audio \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/podcast.m4a","style":"waveform","size":"1080x1080"}'
```

<a id="op-video-slideshow"></a>

#### 图片幻灯片

`POST /api/video/slideshow` · 操作名 `video.slideshow` · 异步任务

把多张图片做成幻灯片视频：58 种 xfade 转场（含随机）、Ken Burns 运动效果、背景音乐，可按音乐长度自动分配每张图的时长。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `images` | 图片 | 是 | 1 ~ 100 个 | `imagesUrls` | 图片，按上传顺序播放（1-100 张，尺寸和格式可以不同） |
| `audio` | 音频 | 否 | 1 个 | `audioUrl` | 背景音乐 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `durationPerImage` | 数字 | 否 | `3` | 每张图显示的秒数（0.5-60，含转场），默认 3；fitToAudio=true 时忽略。范围 0.5 ~ 60 |
| `transition` | 字符串 | 否 | `fade` | 转场效果：none 无转场、random 每次随机，或任一 FFmpeg xfade 转场名（fade、dissolve、wipeleft、slideleft、circleopen、zoomin、fadeblack、pixelize 等），默认 fade。可选 `none` / `random` / `fade` / `wipeleft` / `wiperight` / `wipeup` / `wipedown` / `slideleft` / `slideright` / `slideup` / `slidedown` / `circlecrop` / `rectcrop` / `distance` / `fadeblack` / `fadewhite` / `radial` / `smoothleft` / `smoothright` / `smoothup` / `smoothdown` / `circleopen` / `circleclose` / `vertopen` / `vertclose` / `horzopen` / `horzclose` / `dissolve` / `pixelize` / `diagtl` / `diagtr` / `diagbl` / `diagbr` / `hlslice` / `hrslice` / `vuslice` / `vdslice` / `hblur` / `fadegrays` / `wipetl` / `wipetr` / `wipebl` / `wipebr` / `squeezeh` / `squeezev` / `zoomin` / `fadefast` / `fadeslow` / `hlwind` / `hrwind` / `vuwind` / `vdwind` / `coverleft` / `coverright` / `coverup` / `coverdown` / `revealleft` / `revealright` / `revealup` / `revealdown` |
| `transitionDuration` | 数字 | 否 | `0.5` | 转场时长（0.2-3 秒），默认 0.5；不能超过每张图时长的一半。范围 0.2 ~ 3 |
| `size` | 任意 | 否 | `{"width":1280,"height":720}` | 输出分辨率，默认 1280x720，最大 3840x2160（奇数自动减 1） |
| `fit` | 字符串 | 否 | `contain` | 图片适配方式。contain：完整显示，空白处填背景色；cover：铺满画面，裁掉多出的部分；blur：完整显示，空白处用放大模糊的同一张图填充 |
| `backgroundColor` | 字符串 | 否 | `black` | fit=contain 时的留白颜色，以及透明图片的底色，默认 black |
| `kenBurns` | 布尔 | 否 | `false` | 开启 Ken Burns 效果：每张图缓慢推近、拉远或平移（幅度 12%） |
| `fps` | 数字 | 否 | `25` | 帧率（1-60），默认 25。范围 1 ~ 60 |
| `fitToAudio` | 布尔 | 否 | `false` | 按音频时长平均分配每张图的显示时间，视频与音频等长（需要 audio） |
| `loopAudio` | 布尔 | 否 | `false` | 音频比视频短时循环播放，默认 false（之后静音） |
| `audioFadeIn` | 数字 | 否 | `0` | 音频开头淡入秒数（0-30），默认 0。范围 0 ~ 30 |
| `audioFadeOut` | 数字 | 否 | `2` | 音频结尾淡出秒数（0-30），默认 2。范围 0 ~ 30 |

**说明**

- 时长：不开 fitToAudio 时为 图片数 × durationPerImage − (图片数 − 1) × transitionDuration；开启时等于音频时长，最长 4 小时。
- 每张图只解码一次并缩放到输出尺寸，尺寸、格式（jpg / png / webp / gif / bmp …）可以混用，透明部分填 backgroundColor，动图只取第一帧；单张图片上限 1 亿像素。
- 每 10 张图分一段渲染再流复制拼接，100 张图的内存占用与 10 张相当。
- 有音频时：比视频长的部分截掉，结尾按 audioFadeOut 淡出；比视频短时补静音，或 loopAudio=true 无缝循环。没有音频时输出无音轨的视频。
- transitionDuration 不能超过 durationPerImage 的一半；fitToAudio 时按需要自动缩短转场。
- 分辨率最大 3840x2160，帧率 1-60。

```bash
curl -X POST http://localhost:9527/api/video/slideshow \
  -F "images=@1.jpg" -F "images=@2.png" -F "images=@3.webp" -F "audio=@bgm.mp3" \
  -F "transition=random" -F "kenBurns=true" -F "fitToAudio=true"

# URL 输入
curl -X POST http://localhost:9527/api/video/slideshow \
  -H "Content-Type: application/json" \
  -d '{"imagesUrls":["https://example.com/1.jpg","https://example.com/2.jpg"],
       "durationPerImage":4,"transition":"slideleft","size":"1080x1920","fit":"blur"}'
```

### 音频处理

<a id="op-audio-convert"></a>

#### 音频格式转换

`POST /api/audio/convert` · 操作名 `audio.convert` · 异步任务 · 可在 pipeline 中串联

把音频文件或视频里的音轨转换成 mp3 / m4a / aac / wav / flac / ogg / opus，可以同时调整码率、采样率和声道数。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |
| `sampleRate` | 数字 | 否 |  | 输出采样率（Hz）：8000 / 11025 / 16000 / 22050 / 24000 / 32000 / 44100 / 48000 / 88200 / 96000，不传时保持原采样率（编码器不支持时自动换成最接近的） |
| `channels` | 整数 | 否 |  | 输出声道数：1 单声道、2 立体声，不传时保持原声道（多声道会按编码器能力自动混缩）；单声道转立体声时两个声道音量与原文件相同。范围 1 ~ 2 |

**说明**

- 输入可以是任何带音轨的音视频文件，格式按文件内容识别，不看扩展名；视频只取第一条音轨
- 编码器：mp3 用 libmp3lame，m4a / aac 用 AAC，ogg 用 Vorbis，opus 用 libopus，flac 无损，wav 为 16 位 PCM
- 目标编码和输入相同、且没有指定 bitrate / sampleRate / channels 时直接复制音频流，不重新编码（例如从 mp4 视频提取 m4a），结果的 data.copied 为 true
- mp3 不支持 88200 / 96000 Hz；opus 只支持 8000 / 16000 / 24000 / 48000 Hz
- 码率超过编码器上限时按上限编码（mp3 320k，opus 510k、单声道 256k）；ogg 的码率会换算成 Vorbis VBR 质量等级
- 会保留标题、歌手等全局元数据，不保留封面图

```bash
curl -X POST http://localhost:9527/api/audio/convert -F "file=@song.wav" -F "format=mp3" -F "bitrate=320k"

# 从视频里提取音轨（编码相同时直接复制，不重新编码）
curl -X POST http://localhost:9527/api/audio/convert -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/video.mp4", "format": "m4a"}'
```

<a id="op-audio-normalize"></a>

#### 响度标准化

`POST /api/audio/normalize` · 操作名 `audio.normalize` · 异步任务 · 可在 pipeline 中串联

按 EBU R128 做两遍响度标准化：第一遍测量综合响度、真峰值和响度范围，第二遍按测量值做线性增益，让不同来源的音频听起来一样响。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `targetLufs` | 数字 | 否 | `-14` | 目标综合响度（LUFS，-70 到 -5），默认 -14（主流流媒体平台）；广播电视常用 -23（EBU R128）或 -24（ATSC A/85），播客常用 -16。范围 -70 ~ -5 |
| `truePeak` | 数字 | 否 | `-1` | 真峰值上限（dBTP，-9 到 0），默认 -1。范围 -9 ~ 0 |
| `lra` | 数字 | 否 | `11` | 目标响度范围（LU，1 到 50），默认 11。范围 1 ~ 50 |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- 两遍 loudnorm：第一遍只测量（进度 0-40%），第二遍带 measured_* 和 linear=true 输出（40-100%）
- 任务结果 data 包含 target、input（原始的 i / tp / lra / thresh）、output（输出的实测值）和 normalizationType
- normalizationType 为 linear 表示整体线性增益、不改变动态；当达到目标响度会超过 truePeak，或原始响度范围大于 lra 时，FFmpeg 会退回 dynamic（动态压缩）
- loudnorm 内部按 192 kHz 处理，输出会还原为输入的采样率（目标格式不支持时取最接近的）
- 几乎静音（综合响度低于 -70 LUFS）的输入无法标准化，任务会失败并说明原因；短于 0.4 秒的音频（如短音效）凑不满一个 EBU R128 测量块，测不出综合响度，同样会失败
- 视频请用 /api/video/normalize-audio，画面直接复制

```bash
curl -X POST http://localhost:9527/api/audio/normalize -F "file=@podcast.mp3" -F "targetLufs=-16"

curl -X POST http://localhost:9527/api/audio/normalize -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/song.flac", "targetLufs": -14, "truePeak": -1, "format": "m4a"}'
```

<a id="op-video-normalize-audio"></a>

#### 视频响度标准化

`POST /api/video/normalize-audio` · 操作名 `video.normalize-audio` · 异步任务 · 可在 pipeline 中串联

对视频的音轨做 EBU R128 两遍响度标准化，画面直接复制不重新编码，适合统一一批视频的音量。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 带音轨的视频文件 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `targetLufs` | 数字 | 否 | `-14` | 目标综合响度（LUFS，-70 到 -5），默认 -14（主流流媒体平台）；广播电视常用 -23（EBU R128）或 -24（ATSC A/85），播客常用 -16。范围 -70 ~ -5 |
| `truePeak` | 数字 | 否 | `-1` | 真峰值上限（dBTP，-9 到 0），默认 -1。范围 -9 ~ 0 |
| `lra` | 数字 | 否 | `11` | 目标响度范围（LU，1 到 50），默认 11。范围 1 ~ 50 |
| `format` | 字符串 | 否 |  | 输出容器：mp4 / mkv / mov / webm。不传时沿用输入的容器（按内容识别），原画面编码放不进去时用 mkv |
| `audioBitrate` | 数字 | 否 |  | 音频码率，如 128k、192k（8k-512k），默认 AAC 192k、webm 的 Opus 128k。范围 8 ~ 512 |

**说明**

- 画面流直接复制（-c:v copy），只重新编码音频：mp4 / mov / mkv 用 AAC，webm 用 Opus（48 kHz）
- 只保留第一条视频流和第一条音轨，字幕、其它音轨和数据流不保留
- 容器必须能装下原画面编码：mp4 支持 H.264 / H.265 / AV1 / VP9 等，mov 另外支持 ProRes / DNxHD 等但不支持 VP9 / AV1，webm 只支持 VP8 / VP9 / AV1，mkv 都支持；不兼容时在处理前直接返回明确的错误
- H.265 放进 mp4 / mov 时打上 hvc1 标签，苹果设备可以直接播放
- 任务结果 data 与 /api/audio/normalize 相同（target、input、output、normalizationType），另加 format
- 没有画面的文件请用 /api/audio/normalize；没有音轨的视频会直接失败；音轨几乎静音或短于 0.4 秒（测不出 EBU R128 综合响度）时任务失败并说明原因

```bash
curl -X POST http://localhost:9527/api/video/normalize-audio -F "file=@vlog.mp4" -F "targetLufs=-14"

curl -X POST http://localhost:9527/api/video/normalize-audio -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/clip.mp4", "targetLufs": -16, "truePeak": -1.5}'
```

<a id="op-audio-denoise"></a>

#### 音频降噪

`POST /api/audio/denoise` · 操作名 `audio.denoise` · 异步任务 · 可在 pipeline 中串联

自动测量录音的底噪并用 FFT 频域降噪（afftdn）去掉底噪、电流声和环境噪声，可选高通 / 低通滤波去掉低频轰鸣和高频嘶声。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `strength` | 字符串 | 否 | `medium` | 降噪强度：light 轻度 / medium 中等（默认）/ strong 强力；越强越干净，但弱音和人声细节越容易被压掉 |
| `reduction` | 数字 | 否 |  | 噪声最多衰减多少 dB（1-97），覆盖 strength 预设（light 12、medium 20、strong 30）。范围 1 ~ 97 |
| `noiseFloor` | 数字 | 否 |  | 降噪门限（dBFS，-80 到 -20），低于它的成分按噪声处理；不传时自动测量（底噪电平 + 强度对应的余量）。范围 -80 ~ -20 |
| `highpass` | 数字 | 否 |  | 高通截止频率（Hz，10-2000），去掉低于该频率的轰鸣和风噪，人声常用 80-100。范围 10 ~ 2000 |
| `lowpass` | 数字 | 否 |  | 低通截止频率（Hz，500-48000），去掉高于该频率的嘶声，语音常用 8000-12000。范围 500 ~ 48000 |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- 两遍处理：先按 0.1 秒窗口测电平（进度 0-30%），找出最安静的约 0.5 秒（只有底噪的停顿）作为噪声样本，再降噪输出
- 噪声样本用来学习噪声的频谱形状（对粉红噪声、空调声这类非白噪声效果好得多），降噪门限 = 样本电平 + 余量（light 6 dB、medium 10 dB、strong 14 dB）
- 最安静的一段也高于 -35 dBFS（如没有停顿的音乐）或整段是数字静音时，不采样噪声，门限退回固定值（light -50、medium -45、strong -40 dBFS），避免把音乐当成噪声；这时可以用 noiseFloor 手动指定
- 适合持续、平稳的噪声（底噪、空调、电流声）；突发噪声（敲击、咳嗽）效果有限
- 处理顺序：高通 → 降噪 → 低通。lowpass 必须大于 highpass；lowpass 不低于输入采样率的一半时没有意义，会被忽略（data.lowpass 为 null）
- 任务结果 data：strength、reduction、noiseFloor（实际使用的门限）、measuredNoise（测得的底噪电平，无法测量时为 null）、noiseProfile（sampled 采样了噪声特征 / default 默认白噪声特征）、highpass、lowpass

```bash
curl -X POST http://localhost:9527/api/audio/denoise -F "file=@interview.m4a" -F "strength=strong" -F "highpass=80"

curl -X POST http://localhost:9527/api/audio/denoise -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/voice.wav", "strength": "light", "lowpass": 12000, "format": "mp3"}'
```

<a id="op-audio-trim-silence"></a>

#### 去除静音

`POST /api/audio/trim-silence` · 操作名 `audio.trim-silence` · 异步任务 · 可在 pipeline 中串联

自动检测并去掉开头、结尾的静音，也可以把中间过长的停顿缩短到指定长度，常用于录音、播客和配音的后期整理。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `threshold` | 数字 | 否 | `-50` | 静音阈值（dB，-90 到 -10），低于它算静音，默认 -50；有底噪的录音可以调到 -40 或 -35。范围 -90 ~ -10 |
| `minSilence` | 数字 | 否 | `0.5` | 最短静音时长（秒，0.05-60），短于它的停顿不处理，默认 0.5。范围 0.05 ~ 60 |
| `where` | 字符串 | 否 | `both` | 处理位置：start 只去开头 / end 只去结尾 / both 开头和结尾（默认）/ all 开头结尾都去，并把中间超过 maxGap 的停顿缩短到 maxGap |
| `maxGap` | 数字 | 否 | `0.5` | where=all 时中间停顿保留的最长秒数（0-10），默认 0.5；0 表示完全去掉。范围 0 ~ 10 |
| `padding` | 数字 | 否 | `0` | 去掉开头 / 结尾静音时各保留多少秒静音（0-5），避免声音贴边，默认 0。范围 0 ~ 5 |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- 两遍处理：先用 silencedetect 找出静音段（进度 0-30%），再按算出的保留区间剪切输出
- 静音判断是所有声道都低于 threshold 才算静音
- 只保留一段时按采样点精确裁剪；where=all 产生多段时以约 5 ms 为单位拼接，切口都落在静音里，不会有爆音
- 中间保留区间最多 1000 段，超过时请调大 minSilence
- 整段都是静音时任务失败；没有可去除的静音时照常输出（data.removed 为 0）
- 任务结果 data：originalDuration、duration、removed（去掉的秒数）、silences（检测到的静音段数）、segments（保留的段数）

```bash
curl -X POST http://localhost:9527/api/audio/trim-silence -F "file=@recording.wav" -F "threshold=-45"

# 去掉首尾静音，并把中间超过 0.3 秒的停顿缩短到 0.3 秒
curl -X POST http://localhost:9527/api/audio/trim-silence -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/podcast.mp3", "where": "all", "minSilence": 0.3, "maxGap": 0.3}'
```

<a id="op-audio-volume"></a>

#### 调整音量

`POST /api/audio/volume` · 操作名 `audio.volume` · 异步任务 · 可在 pipeline 中串联

按分贝或倍数放大、减小音量，放大时默认加限幅器防止削波失真。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `gain` | 数字 | 否 |  | 增益（dB，-60 到 60），正数放大、负数减小，如 6 约等于音量翻倍。与 factor 二选一。范围 -60 ~ 60 |
| `factor` | 数字 | 否 |  | 音量倍数（0-10），1 为原音量、0.5 减半、2 放大一倍、0 静音。与 gain 二选一。范围 0 ~ 10 |
| `limiter` | 布尔 | 否 |  | 是否加限幅器防止削波，默认放大时开启、减小时关闭 |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- gain 和 factor 必须且只能提供一个
- 限幅器把峰值压在约 -0.26 dBFS 以下，避免放大后爆音；想要可预测的统一响度请用 /api/audio/normalize

```bash
curl -X POST http://localhost:9527/api/audio/volume -F "file=@quiet.mp3" -F "gain=6"

curl -X POST http://localhost:9527/api/audio/volume -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/loud.wav", "factor": 0.5}'
```

<a id="op-audio-fade"></a>

#### 音频淡入淡出

`POST /api/audio/fade` · 操作名 `audio.fade` · 异步任务 · 可在 pipeline 中串联

给音频开头加淡入、结尾加淡出，可选淡变曲线。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `fadeIn` | 数字 | 否 | `0` | 淡入时长（秒，0-600），0 表示不淡入。范围 0 ~ 600 |
| `fadeOut` | 数字 | 否 | `0` | 淡出时长（秒，0-600），在结尾处结束，0 表示不淡出。范围 0 ~ 600 |
| `curve` | 字符串 | 否 | `tri` | 淡变曲线，默认 tri（线性）。tri 线性、qsin 四分之一正弦、hsin 半正弦、esin 指数正弦、log 对数、exp 指数、par 抛物线、qua 二次、cub 三次、squ 平方根、cbr 立方根等，与 FFmpeg afade 的 curve 一致。可选 `tri` / `qsin` / `esin` / `hsin` / `log` / `ipar` / `qua` / `cub` / `squ` / `cbr` / `par` / `exp` / `iqsin` / `ihsin` / `dese` / `desi` / `losi` / `sinc` / `isinc` / `quat` / `quatr` / `qsin2` / `hsin2` |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- fadeIn 和 fadeOut 至少设置一个；两者之和不能超过音频时长
- 淡出起点按探测到的时长计算，时长无法获取时不能淡出

```bash
curl -X POST http://localhost:9527/api/audio/fade -F "file=@song.mp3" -F "fadeIn=2" -F "fadeOut=5"

curl -X POST http://localhost:9527/api/audio/fade -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/bgm.m4a", "fadeOut": 3, "curve": "qsin"}'
```

<a id="op-audio-speed"></a>

#### 变速 / 变调

`POST /api/audio/speed` · 操作名 `audio.speed` · 异步任务 · 可在 pipeline 中串联

改变音频播放速度而不改变音高，或者升降调而不改变速度，两者也可以同时调整。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `tempo` | 数字 | 否 | `1` | 速度倍数（0.5-4），1 为原速、1.5 加快 50%、0.75 放慢；音高不变。范围 0.5 ~ 4 |
| `pitch` | 数字 | 否 | `0` | 升降调（半音，-12 到 12，可以是小数），12 为升高一个八度；速度不变。范围 -12 ~ 12 |
| `preserveFormant` | 布尔 | 否 | `false` | 变调时保留共振峰，人声听起来更自然（不像花栗鼠），默认 false |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- tempo 和 pitch 至少要改一个
- 只变速时用 atempo（WSOLA 算法）；变调时用 rubberband（librubberband），FFmpeg 没有编译 rubberband 时自动退回 asetrate + atempo 方案（此时 preserveFormant 无效）
- 输出时长 = 原时长 / tempo；任务结果 data.engine 说明实际使用的算法

```bash
curl -X POST http://localhost:9527/api/audio/speed -F "file=@lecture.mp3" -F "tempo=1.5"

# 降 2 个半音并保留人声音色
curl -X POST http://localhost:9527/api/audio/speed -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/song.mp3", "pitch": -2, "preserveFormant": true}'
```

<a id="op-audio-trim"></a>

#### 音频裁剪

`POST /api/audio/trim` · 操作名 `audio.trim` · 异步任务 · 可在 pipeline 中串联

截取音频的一段，按采样点精确裁剪（不受编码帧边界影响）。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `startTime` | 数字 | 否 | `0` | 开始时间，秒数（12.5）或 HH:MM:SS(.mmm)（00:01:02.5），默认 0。最小 0 |
| `endTime` | 数字 | 否 |  | 结束时间，格式同 startTime；与 duration 二选一，都不传时截到结尾。最小 0 |
| `duration` | 数字 | 否 |  | 截取时长，秒数或 HH:MM:SS；与 endTime 二选一。最小 0 |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- 用 atrim 滤镜从头解码后按采样点裁剪，起止点精确；因为要重新编码，无损格式（wav / flac）之外会有一次有损编码
- endTime 或 startTime + duration 超过音频长度时截到结尾；startTime 超过音频长度时任务失败

```bash
curl -X POST http://localhost:9527/api/audio/trim -F "file=@song.mp3" -F "startTime=00:00:30" -F "duration=15"

curl -X POST http://localhost:9527/api/audio/trim -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/podcast.m4a", "startTime": "1:02.5", "endTime": "2:10"}'
```

<a id="op-audio-reverse"></a>

#### 音频倒放

`POST /api/audio/reverse` · 操作名 `audio.reverse` · 异步任务 · 可在 pipeline 中串联

把音频从尾到头倒着播放。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨，输出为纯音频） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- 倒放需要把整段音频读进内存，最长 30 分钟（按 48 kHz 立体声计；采样率更高或声道更多时相应缩短），超过时任务失败
- 内部以 16 位精度缓存以减少内存占用

```bash
curl -X POST http://localhost:9527/api/audio/reverse -F "file=@sample.wav"

curl -X POST http://localhost:9527/api/audio/reverse -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/sfx.mp3", "format": "ogg"}'
```

<a id="op-audio-concat"></a>

#### 音频拼接

`POST /api/audio/concat` · 操作名 `audio.concat` · 异步任务

把多个音频首尾相连拼成一个文件，可以在相邻两段之间做交叉淡化；采样率、声道、格式不同的文件也能直接拼。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `files` | 视频或音频 | 是 | 2 ~ 50 个 | `filesUrls` | 按顺序拼接的音频（或带音轨的视频），2-50 个 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `crossfade` | 数字 | 否 | `0` | 相邻两段交叉淡化的秒数（0-30），0 表示直接拼接（默认）。范围 0 ~ 30 |
| `curve` | 字符串 | 否 | `tri` | 交叉淡化曲线，默认 tri（线性）。tri 线性、qsin 四分之一正弦、hsin 半正弦、esin 指数正弦、log 对数、exp 指数、par 抛物线、qua 二次、cub 三次、squ 平方根、cbr 立方根等，与 FFmpeg afade 的 curve 一致。可选 `tri` / `qsin` / `esin` / `hsin` / `log` / `ipar` / `qua` / `cub` / `squ` / `cbr` / `par` / `exp` / `iqsin` / `ihsin` / `dese` / `desi` / `losi` / `sinc` / `isinc` / `quat` / `quatr` / `qsin2` / `hsin2` |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- 2-50 个文件，按上传 / URL 列表的顺序拼接；视频文件只取第一条音轨
- 所有输入先统一成相同的采样率（输入中最高的，输出格式不支持时取最接近的）和声道（任一输入是多声道就输出立体声），再拼接；单声道输入原样复制到左右声道，音量不变，5.1 等多声道输入按 FFmpeg 标准方式缩混为立体声
- crossfade > 0 时相邻两段重叠 crossfade 秒，总时长 = 各段之和 - (n-1) × crossfade；每个文件都必须比 crossfade 长
- 不传 format 时沿用第 1 个文件的格式（不是可输出的音频格式时用 mp3）
- 有输入没有时长信息（管道写出的 webm、浏览器 MediaRecorder 录音）时编码中不汇报细分进度，任务结果 data.duration 取实际输出的长度

```bash
curl -X POST http://localhost:9527/api/audio/concat -F "files=@intro.mp3" -F "files=@main.wav" -F "files=@outro.m4a" -F "crossfade=1.5"

curl -X POST http://localhost:9527/api/audio/concat -H "Content-Type: application/json" \
  -d '{"filesUrls": ["https://example.com/a.mp3", "https://example.com/b.mp3"], "format": "mp3"}'
```

<a id="op-audio-mix"></a>

#### 多轨混音

`POST /api/audio/mix` · 操作名 `audio.mix` · 异步任务

把多个音频叠在一起同时播放（如人声 + 背景音乐），每一轨可以单独设音量和起始延迟。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `files` | 视频或音频 | 是 | 2 ~ 8 个 | `filesUrls` | 要混合的音频（或带音轨的视频），2-8 个 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `volumes` | 数字 数组 | 否 |  | 每一轨的音量倍数，逗号分隔或数组，个数必须等于文件数（如 1,0.3：第 1 轨原音量、第 2 轨 30%），默认都为 1 |
| `delays` | 数字 数组 | 否 |  | 每一轨延迟多少秒开始（0-3600），逗号分隔或数组，个数必须等于文件数，默认都为 0 |
| `duration` | 字符串 | 否 | `longest` | 输出时长：longest 最长的一轨（默认）/ shortest 最短的一轨 / first 第一轨 |
| `limiter` | 布尔 | 否 | `true` | 混音后加限幅器防止叠加后削波，默认 true |
| `format` | 字符串 | 否 |  | 输出格式：mp3 / m4a / aac / wav / flac / ogg / opus。不传时沿用输入文件的格式（按内容识别，不看扩展名），输入不是这几种（如视频）时输出 mp3 |
| `bitrate` | 数字 | 否 |  | 输出码率，如 128k、192k、320k（8k-512k）。不传时 mp3 / m4a / aac 用 192k，opus 用 128k，ogg 用 VBR 质量 6（约 192k）；wav / flac 是无损格式，忽略此参数。范围 8 ~ 512 |

**说明**

- 2-8 个文件；视频文件只取第一条音轨
- 各轨按原音量相加（不做 amix 默认的平均衰减），所以加在一起可能变响；默认开启的限幅器把峰值压在约 -0.26 dBFS
- 所有输入先统一采样率（取最高的）和声道（任一输入是多声道就输出立体声）；单声道输入原样复制到左右声道，音量不变
- duration 计算包含 delays；不传 format 时沿用第 1 个文件的格式（不是可输出的音频格式时用 mp3）
- 有输入没有时长信息（管道写出的 webm、浏览器 MediaRecorder 录音）时编码中不汇报细分进度，任务结果 data.duration 取实际输出的长度

```bash
curl -X POST http://localhost:9527/api/audio/mix -F "files=@voice.wav" -F "files=@bgm.mp3" -F "volumes=1,0.25" -F "duration=first"

curl -X POST http://localhost:9527/api/audio/mix -H "Content-Type: application/json" \
  -d '{"filesUrls": ["https://example.com/voice.mp3", "https://example.com/bgm.mp3"], "volumes": [1, 0.3], "delays": [2, 0]}'
```

<a id="op-audio-waveform"></a>

#### 波形图

`POST /api/audio/waveform` · 操作名 `audio.waveform` · 异步任务 · 可在 pipeline 中串联

把整段音频的波形画成一张 PNG 图片，可设置尺寸、颜色、背景（或透明）和刻度。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `size` | 对象 | 否 | `{"width":1200,"height":240}` | 图片尺寸 宽x高，默认 1200x240，最大 7680x4320 |
| `color` | 字符串 | 否 | `0x3B82F6` | 波形颜色：颜色名、#RRGGBB 或 #RRGGBBAA，可带 @透明度，默认 #3B82F6 |
| `backgroundColor` | 字符串 | 否 |  | 背景颜色，格式同 color，默认白色；与 transparent 二选一 |
| `transparent` | 布尔 | 否 | `false` | 透明背景（PNG 带 alpha 通道），默认 false |
| `mode` | 字符串 | 否 | `combined` | combined 所有声道画在一起（默认）/ split 每个声道单独一行 |
| `scale` | 字符串 | 否 | `lin` | 振幅刻度：lin 线性（默认）/ log 对数 / sqrt 平方根 / cbrt 立方根；后三种让小声部分更明显 |
| `amplitude` | 字符串 | 否 | `average` | 每列取值方式：average 平均值（默认）/ peak 峰值（波形更饱满） |

**说明**

- 输出 PNG，尺寸与 size 完全一致；transparent=true 时为 RGBA，否则为 RGB
- 音频最长 3 小时；超过约 10 分钟的音频先降采样再画（不影响波形轮廓），控制内存占用
- 图片在整段音频读完后才生成，处理过程中进度不会逐步增长

```bash
curl -X POST http://localhost:9527/api/audio/waveform -F "file=@song.mp3" -F "size=1600x200" -F "color=#FF5500" -F "transparent=true"

curl -X POST http://localhost:9527/api/audio/waveform -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/podcast.m4a", "mode": "split", "backgroundColor": "black", "color": "lime"}'
```

<a id="op-audio-spectrogram"></a>

#### 频谱图

`POST /api/audio/spectrogram` · 操作名 `audio.spectrogram` · 异步任务 · 可在 pipeline 中串联

把整段音频的时频谱（横轴时间、纵轴频率、颜色表示能量）画成一张 PNG 图片。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频文件，或带音轨的视频（使用第一条音轨） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `size` | 对象 | 否 | `{"width":1200,"height":600}` | 频谱区域尺寸 宽x高，默认 1200x600，最大 7680x4320；带图例时整张图会更大 |
| `legend` | 布尔 | 否 | `true` | 是否画坐标轴和图例（时间、频率刻度和色标），默认 true |
| `colorScheme` | 字符串 | 否 | `intensity` | 配色：intensity（默认）/ rainbow / magma / viridis / plasma / cividis / fire / fiery / nebulae / moreland / fruit / cool / green / terrain / channel（每个声道一种颜色） |
| `scale` | 字符串 | 否 | `log` | 能量刻度：log 对数（默认）/ lin / sqrt / cbrt / 4thrt / 5thrt |
| `frequencyScale` | 字符串 | 否 | `lin` | 频率轴刻度：lin 线性（默认）/ log 对数（低频细节更多，适合音乐） |
| `mode` | 字符串 | 否 | `combined` | combined 所有声道合成一张（默认）/ separate 每个声道单独画 |
| `minFrequency` | 整数 | 否 |  | 显示的最低频率（Hz），默认 0。范围 0 ~ 96000 |
| `maxFrequency` | 整数 | 否 |  | 显示的最高频率（Hz），默认到采样率的一半；必须大于 minFrequency。范围 1 ~ 96000 |
| `dynamicRange` | 数字 | 否 | `120` | 动态范围（dB，10-200），默认 120；调小后弱信号显示更少、对比更强。范围 10 ~ 200 |

**说明**

- legend=false 时图片尺寸与 size 完全一致；legend=true 时四周加上坐标和色标，整张图比 size 大（1200x600 约为 1482x728）
- 需要把整段音频读进内存，最长 30 分钟（按 48 kHz 单声道计；mode=separate 或 colorScheme=channel 时按声道数缩短）；combined 模式会先混成单声道以节省内存
- maxFrequency 不能超过输入采样率的一半
- 图片在整段音频读完后才生成，处理过程中进度不会逐步增长

```bash
curl -X POST http://localhost:9527/api/audio/spectrogram -F "file=@song.flac" -F "colorScheme=magma" -F "frequencyScale=log"

curl -X POST http://localhost:9527/api/audio/spectrogram -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/voice.wav", "size": "1600x800", "maxFrequency": 8000, "legend": false}'
```

### 分析、流媒体与图片

<a id="op-analyze-loudness"></a>

#### 响度分析

`POST /api/analyze/loudness` · 操作名 `analyze.loudness` · 异步任务

按 EBU R128 / ITU-R BS.1770 测量音频或视频音轨的综合响度（LUFS）、响度范围（LRA）和真峰值（dBTP），并给出平均 / 最大音量。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 要分析的音频或带音轨的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `timeline` | 布尔 | 否 | `false` | 同时返回响度曲线：默认每秒一个点，含瞬时响度 momentary（400 毫秒窗口）和短期响度 shortTerm（3 秒窗口），单位 LUFS |
| `target` | 数字 | 否 |  | 目标响度（LUFS），如 -14（主流流媒体平台）、-16（播客）、-23（EBU R128 广播）。给了会额外返回达到目标需要的增益和增益后的真峰值。范围 -70 ~ -5 |

**说明**

- 结果在任务详情的 result 里：integratedLufs（综合响度）、lraLu（响度范围）、truePeakDbtp（真峰值）、samplePeakDbfs（采样峰值）、thresholdLufs、lraLowLufs、lraHighLufs，以及 volumedetect 的 meanVolumeDb / maxVolumeDb。
- 全程静音时 integratedLufs 为 -70、silent 为 true，峰值、thresholdLufs、lraLowLufs、lraHighLufs 为 null，lraLu 为 0。
- 音频短于 0.4 秒（如短音效）时凑不满一个 EBU R128 测量块，tooShort 为 true，integratedLufs、thresholdLufs、lraLu、lraLowLufs、lraHighLufs 和 target.gainDb 为 null；峰值和平均 / 最大音量照常返回，silent 只在采样峰值低于 -70 dBFS 时为 true。
- duration 取容器时长和实际解码长度中较大的一个，没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录音）也能拿到真实时长。
- 给了 target 时返回 target 对象：gainDb 是达到目标需要的增益，truePeakAfterGainDbtp 是增益后的真峰值，超过 -1 dBTP 时 clipRisk 为 true（直接放大会削波，建议用 /api/audio/normalize 做带限幅的响度标准化）。
- timeline=true 时返回 timeline.points：[{ time, momentary, shortTerm }]，默认每秒一个点，超过 3600 个点时自动加大间隔（interval 字段）；低于 -70 LUFS 的值记为 -70。
- 多音轨文件只分析第一条音轨；没有音轨的文件直接失败。

```bash
curl -X POST http://localhost:9527/api/analyze/loudness \
  -F "file=@input.mp3" -F "target=-14"

# URL 输入，同时返回响度曲线
curl -X POST http://localhost:9527/api/analyze/loudness \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","timeline":true}'
```

<a id="op-analyze-scenes"></a>

#### 场景切换检测

`POST /api/analyze/scenes` · 操作名 `analyze.scenes` · 异步任务

找出视频里的镜头切换点，把视频分成一个个场景，可选为每个场景导出缩略图。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要分析的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `threshold` | 数字 | 否 | `0.3` | 切换灵敏度（0.05-0.95），前后两帧差异超过它算新场景，默认 0.3。越小越敏感，渐变转场多的素材可以调到 0.2。范围 0.05 ~ 0.95 |
| `minInterval` | 数字 | 否 | `0` | 两个切换点之间的最短间隔（秒，0-3600），用来过滤闪光、快速切换造成的碎片，默认 0（不过滤）。范围 0 ~ 3600 |
| `thumbnails` | 布尔 | 否 | `false` | 是否为每个场景的第一帧导出一张 jpg 缩略图（最多 100 张），默认 false |
| `thumbnailWidth` | 整数 | 否 | `320` | 缩略图宽度（像素，16-1920），高度按比例，默认 320；不会放大。范围 16 ~ 1920 |

**说明**

- 结果：scenes（[{ index, start, end, duration, score, thumbnail? }]，秒）和 sceneCount。score 是切入该场景时前后两帧的差异（0-1），第一个场景为 null。
- minInterval 从视频开头算起：离开头或上一个切换点不到 minInterval 秒的切换点会被忽略。
- thumbnails=true 时每个场景第一帧导出一张 jpg（scene_001.jpg 起编号，宽度默认 320），最多 100 张，超过时只导出前 100 个场景并把 thumbnailsTruncated 设为 true；scenes[i].thumbnail 是对应的文件名，产物 files 是全部缩略图。
- 场景最多返回 5000 个，超过时 truncated 为 true（sceneCount 仍是实际数量）。
- 检测要解码整段视频，耗时和视频长度、分辨率成正比；渐变（淡入淡出、叠化）转场的差异分数较低，可能需要调小 threshold。只分析第一路画面，没有画面的文件直接失败。
- 没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录屏）按实际解码长度计算 duration 和最后一个场景的结尾。

```bash
curl -X POST http://localhost:9527/api/analyze/scenes \
  -F "file=@input.mp4" -F "threshold=0.3" -F "thumbnails=true"

# URL 输入，过滤 1 秒内的连续切换
curl -X POST http://localhost:9527/api/analyze/scenes \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","minInterval":1}'
```

<a id="op-analyze-silence"></a>

#### 静音检测

`POST /api/analyze/silence` · 操作名 `analyze.silence` · 异步任务

找出音频或视频音轨里的静音片段，同时给出有声片段，可用于自动剪掉停顿、切分录音。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 要分析的音频或带音轨的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `noise` | 数字 | 否 | `-50` | 静音阈值（dB），低于它算静音，默认 -50。嘈杂的录音可以调高到 -40 ~ -30。范围 -90 ~ 0 |
| `minDuration` | 数字 | 否 | `0.5` | 最短静音时长（秒），短于它的停顿不计入，默认 0.5。范围 0.01 ~ 3600 |

**说明**

- 结果：silences（静音区间 [{ start, end, duration }]，秒）、totalSilence（静音总时长）、nonSilent（静音之外的有声区间）、silenceRatio（静音占比 0-1）。
- 时间按文件的时间轴（和播放器一致）：音轨晚于画面开始、或比画面先结束时，没有声音的开头 / 结尾也算静音（同样要达到 minDuration）。没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录音）按实际解码长度计算。
- 多声道音频要所有声道都低于阈值才算静音；多音轨文件只分析第一条音轨，没有音轨的文件直接失败。
- 区间最多返回 10000 条，超过时 truncated 为 true。

```bash
curl -X POST http://localhost:9527/api/analyze/silence \
  -F "file=@podcast.mp3" -F "noise=-45" -F "minDuration=1"

# URL 输入
curl -X POST http://localhost:9527/api/analyze/silence \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/talk.m4a","noise":-50,"minDuration":0.5}'
```

<a id="op-analyze-black"></a>

#### 黑场检测

`POST /api/analyze/black` · 操作名 `analyze.black` · 异步任务

找出视频里的黑场片段（片头片尾、转场、广告插入点），返回每段的起止时间。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要分析的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `minDuration` | 数字 | 否 | `0.5` | 最短黑场时长（秒），短于它的不计入，默认 0.5。范围 0.01 ~ 3600 |
| `pixelThreshold` | 数字 | 否 | `0.1` | 像素亮度低于多少（0-1）算黑，默认 0.1；画面偏灰的黑场可以调高到 0.15。范围 0 ~ 1 |
| `pictureThreshold` | 数字 | 否 | `0.98` | 一帧里黑像素占比达到多少（0-1）算黑场，默认 0.98；带台标的黑场可以调低到 0.9。范围 0 ~ 1 |

**说明**

- 结果：intervals（黑场区间 [{ start, end, duration }]，秒）、count、totalBlack（黑场总时长）。
- 区间最多返回 10000 条，超过时 truncated 为 true。只分析第一路画面，没有画面的文件直接失败。
- 没有时长信息的文件（管道写出的 webm、浏览器 MediaRecorder 录屏）按实际解码长度计算 duration。

```bash
curl -X POST http://localhost:9527/api/analyze/black \
  -F "file=@input.mp4" -F "minDuration=0.2"

# URL 输入
curl -X POST http://localhost:9527/api/analyze/black \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","pixelThreshold":0.12}'
```

<a id="op-analyze-peaks"></a>

#### 波形峰值

`POST /api/analyze/peaks` · 操作名 `analyze.peaks` · 异步任务

生成音频播放器（wavesurfer.js 等）画波形用的峰值数据：把音轨分成 points 段，每段给出最小 / 最大采样值（-1 到 1）。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频或音频 | 是 | 1 个 | `url`、`fileUrl` | 音频或带音轨的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `points` | 整数 | 否 | `1000` | 波形点数（100-20000），通常取播放器宽度的像素数，默认 1000。范围 100 ~ 20000 |
| `channels` | 字符串 | 否 | `mono` | mono：所有声道合成一条波形（每个点取全部声道的最小 / 最大值），默认；split：每个声道一条 |
| `normalize` | 布尔 | 否 | `false` | 是否把最大峰值放大到 ±1，让很轻的音频也能画出饱满的波形，默认 false |
| `output` | 字符串 | 否 | `data` | data：峰值放在任务结果里，默认；file：峰值写成 JSON 文件作为产物（点数多时推荐，任务结果里只保留元信息） |

**说明**

- 结果：{ duration, sampleRate, sourceSampleRate, sourceChannels, points, channels, mode, normalized, peaks }。mono 模式 peaks 是 [[min, max], …]；split 模式是每个声道一个这样的数组：[[[min, max], …], [[min, max], …]]。
- 数值是采样值除以 32768，范围 -1 到 1，保留 4 位小数；normalize=true 时按全曲最大峰值放大到 ±1。
- 音频先解码成低采样率的 PCM（默认 8 kHz，很长的音频最低 2 kHz，很短的音频会提高）再统计，所以 sampleRate 是分析用的采样率；split 模式最多 8 个声道。
- 音频的采样数少于 points 时，实际点数会变少（以结果里的 points 为准）。
- output=file 时峰值写成一个 JSON 文件（内容与 data 模式的结果相同），任务结果里不再包含 peaks，适合大点数、避免任务详情过大。
- 多音轨文件只分析第一条音轨；没有音轨的文件直接失败。

```bash
curl -X POST http://localhost:9527/api/analyze/peaks \
  -F "file=@song.mp3" -F "points=800"

# URL 输入，左右声道分开，结果写成 JSON 文件
curl -X POST http://localhost:9527/api/analyze/peaks \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/song.mp3","points":4000,"channels":"split","output":"file"}'
```

<a id="op-video-hls"></a>

#### HLS 多码率切片

`POST /api/video/hls` · 操作名 `video.hls` · 异步任务

把视频转成 HLS 自适应码率流：一次编码出多档清晰度（H.264 / AAC），生成主播放列表 master.m3u8、每档的播放列表和分片。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要切片的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `renditions` | 整数 数组 | 否 |  | 清晰度列表（短边像素，横屏即高度），逗号分隔，如 1080,720,480，最多 4 档。默认：源画面一档加上更低的标准档（1080/720/480/360/240…）。高于源画面的档位会被丢掉，不放大。1 ~ 4 项 |
| `segmentDuration` | 整数 | 否 | `6` | 每个分片的时长（秒，2-10 的整数），默认 6。范围 2 ~ 10 |
| `audioBitrate` | 任意 | 否 | `128` | 每档的 AAC 音频码率，32k-320k，默认 128k |
| `segmentType` | 字符串 | 否 | `ts` | 分片格式：ts（MPEG-TS，兼容性最好，默认）或 fmp4（fMP4 / CMAF，每档多一个 720p_init.mp4 这样的初始化分片，新播放器和 DRM 方案更常用） |

**说明**

- 所有文件在同一个目录里，播放列表里都是相对路径：master.m3u8 引用 720p.m3u8 这样的分档列表，分档列表引用 720p_000.ts 这样的分片。上传到对象存储或静态服务器时保持目录结构即可直接播放。
- 配置了 S3 对象存储且使用预签名链接（没有设置 S3_PUBLIC_BASE_URL）时，服务会把播放列表里的引用改写成各文件自己的签名链接后再上传，可以直接播放，但链接在 S3_PRESIGN_EXPIRES_SECONDS（默认 7 天）后失效；长期提供播放请设置 S3_PUBLIC_BASE_URL（公开读的桶或 CDN）。
- 产物 files 是目录里的全部文件，主产物（primary）是 master.m3u8；任务结果 result 里有每档的名称、宽高、码率上限和播放列表文件名。
- 清晰度按短边计算（竖屏视频 720 指宽 720），宽高按源画面比例取偶数；最多 4 档，每档不超过 7680x4320（超出的档位跳过），帧率高于 60 的源降到 60。带旋转元数据的手机视频按摆正后的方向计算。
- 编码为 H.264（veryfast、CRF 23，按分辨率设码率上限）+ AAC 双声道；所有档位的关键帧都对齐到分片边界，播放器可以无缝切换清晰度。
- 没有音轨的视频只输出画面；多音轨文件只用第一条音轨。每档最多 2000 个分片，超长视频请调大 segmentDuration。

```bash
curl -X POST http://localhost:9527/api/video/hls \
  -F "file=@input.mp4" -F "renditions=1080,720,480" -F "segmentDuration=6"

# URL 输入，fMP4 分片
curl -X POST http://localhost:9527/api/video/hls \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","renditions":[720,360],"segmentType":"fmp4"}'
```

<a id="op-video-dash"></a>

#### DASH 多码率切片

`POST /api/video/dash` · 操作名 `video.dash` · 异步任务

把视频转成 MPEG-DASH 自适应码率流：一次编码出多档清晰度（H.264 / AAC，fMP4 分片），生成 manifest.mpd；可选同时生成 HLS 播放列表。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 视频 | 是 | 1 个 | `url`、`fileUrl` | 要切片的视频 |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `renditions` | 整数 数组 | 否 |  | 清晰度列表（短边像素，横屏即高度），逗号分隔，如 1080,720,480，最多 4 档。默认：源画面一档加上更低的标准档。高于源画面的档位会被丢掉，不放大。1 ~ 4 项 |
| `segmentDuration` | 整数 | 否 | `4` | 每个分片的时长（秒，2-10 的整数），默认 4。范围 2 ~ 10 |
| `audioBitrate` | 任意 | 否 | `128` | AAC 音频码率，32k-320k，默认 128k |
| `hlsPlaylist` | 布尔 | 否 | `false` | 是否同时生成引用同一批 fMP4 分片的 HLS 播放列表（master.m3u8），一份分片同时支持 DASH 和 HLS 播放器，默认 false |

**说明**

- 所有文件在同一个目录里，manifest.mpd 用 SegmentList 逐个列出每档的初始化分片和媒体分片（init-stream0.m4s、chunk-stream0-00001.m4s…，相对路径，标称时长为 segmentDuration）；保持目录结构上传即可播放（dash.js、Shaka Player、ExoPlayer）。不用 SegmentTemplate 模板，所以对象存储预签名模式下每个引用都能换成各自的签名 URL。
- 预签名链接在 S3_PRESIGN_EXPIRES_SECONDS（默认 7 天）后失效；长期提供播放请设置 S3_PUBLIC_BASE_URL（公开读的桶或 CDN）。
- 产物 files 是目录里的全部文件，主产物（primary）是 manifest.mpd；hlsPlaylist=true 时目录里还有 master.m3u8 和 media_N.m3u8。
- 画面各档放在一个 AdaptationSet、音频单独一个 AdaptationSet（所有档共用一路音频）；为满足 DASH 同一 AdaptationSet 画面比例必须一致的要求，各档统一设置显示比例，像素宽高比可能不是 1:1。
- 清晰度按短边计算，最多 4 档，每档不超过 7680x4320，帧率高于 60 的源降到 60；关键帧对齐到分片边界。没有音轨的视频只输出画面。每档最多 2000 个分片。

```bash
curl -X POST http://localhost:9527/api/video/dash \
  -F "file=@input.mp4" -F "renditions=1080,720,360"

# URL 输入，同时生成 HLS 播放列表
curl -X POST http://localhost:9527/api/video/dash \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/input.mp4","hlsPlaylist":true}'
```

<a id="op-image-convert"></a>

#### 图片格式转换

`POST /api/image/convert` · 操作名 `image.convert` · 异步任务 · 可在 pipeline 中串联

图片格式互转（png / jpg / webp / avif / bmp / tiff），可同时缩放、裁剪、补边和调整质量，并去掉 EXIF 等元数据。

**输入文件**

| 上传字段 | 文件类型 | 必填 | 数量 | 改用链接时的字段 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `file` | 图片 | 是 | 1 个 | `url`、`fileUrl` | 要转换的图片（png、jpg、webp、gif、bmp、tiff、avif 等） |

**参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `format` | 字符串 | 否 |  | 输出格式：png、jpg（也接受 jpeg）、webp、avif、bmp、tiff（也接受 tif）。不传时沿用输入格式（GIF 等其他格式输出 png） |
| `width` | 整数 | 否 |  | 输出宽度（像素，1-16383）。只给宽或高时按比例缩放，都不给时保持原尺寸。范围 1 ~ 16383 |
| `height` | 整数 | 否 |  | 输出高度（像素，1-16383）。范围 1 ~ 16383 |
| `fit` | 字符串 | 否 | `contain` | 同时给了宽和高时的缩放方式：contain（等比缩放到框内，不裁剪，默认）、cover（等比铺满后居中裁掉多余部分，正好 宽x高）、stretch（拉伸到 宽x高，不保持比例） |
| `background` | 字符串 | 否 |  | 背景色，如 white、#000000、#00000000（透明）。给了时：contain 补边到正好 宽x高，原图的透明区域也铺上这个颜色。不给时：jpg / bmp 的透明区域铺白色，png / webp / avif / tiff 保留透明 |
| `quality` | 整数 | 否 |  | 质量 1-100，越大越清晰、文件越大。默认 jpg 85、webp 80、avif 60；png / bmp / tiff 是无损格式，忽略此参数。范围 1 ~ 100 |
| `lossless` | 布尔 | 否 | `false` | webp / avif 使用无损压缩（忽略 quality），默认 false；jpg 不支持 |

**说明**

- 动图（GIF、APNG）和视频只取第一帧。动态 WebP 只有 FFmpeg 9 能解码（Docker 镜像满足），本地 FFmpeg 8 会报「无法读取图片尺寸」。
- 带 EXIF 方向标记的照片（手机竖拍）会先按方向摆正，再去掉 EXIF；输出不含 EXIF、注释等元数据，也不带编码器标识。ICC 色彩配置在输出 png / jpg 时保留；webp / avif 不写 ICC，非 sRGB 的源图（如 Display P3 照片）转成这两种格式后颜色可能偏淡。
- contain 不给 background 时输出可能比框小一边；给了 background 时补边到正好 宽x高。cover 正好输出 宽x高，居中裁剪。
- 透明通道：png / webp / avif / tiff 保留；jpg / bmp 不支持透明，透明区域铺 background（默认白色，忽略颜色里的透明度）。给了不透明的 background 时所有格式都会铺底；半透明的 background 只用于补边。avif 的透明通道以独立的 alpha 图层编码。
- 尺寸上限：输入每边 32768、输出每边 16383，总像素都不超过 100 百万。
- quality 映射：jpg 对应 mjpeg q:v 31-2，webp 直接用作 libwebp quality，avif 对应 libaom CRF 63-1；quality ≥ 90 时 jpg / avif 改用 4:4:4 色度采样。lossless 只对 webp / avif 生效（avif 的无损受 RGB→YUV 转换影响，接近无损）。tiff 固定输出 8 位 RGB(A)，deflate 压缩。
- 结果 result 里有 { format, width, height, size, quality, alpha }：输出图片的实际宽高、字节数、实际使用的质量（无损时为 null）和是否带透明通道。

```bash
# 转成宽 800 的 webp
curl -X POST http://localhost:9527/api/image/convert \
  -F "file=@photo.jpg" -F "format=webp" -F "width=800" -F "quality=80"

# URL 输入：裁成 512x512 的正方形 avif
curl -X POST http://localhost:9527/api/image/convert \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/photo.png","format":"avif","width":512,"height":512,"fit":"cover"}'
```
<!-- END GENERATED: operation-reference -->

---

## 完整使用流程示例

以「在线合成视频 + 背景音乐」为例：

```bash
# 1. 提交合成任务，完成后回调
curl -s -X POST http://localhost:9527/api/compose \
  -H "Content-Type: application/json" \
  -d '{
    "videos": [
      "https://example.com/video1.mp4",
      "https://example.com/video2.mp4"
    ],
    "music": "https://example.com/bgm.mp3",
    "musicVolume": 0.3,
    "callbackUrl": "https://example.com/hooks/ffmpeg"
  }'
# {"success":true,"data":{"taskId":"abc-123","status":"pending"}}

# 2. 查询进度（或订阅 /api/tasks/abc-123/progress，或等回调）
curl http://localhost:9527/api/tasks/abc-123
# {"success":true,"data":{"status":"processing","progress":65,"phase":"merging",...}}

# 3. 完成后按 primaryUrl / downloadUrl 下载
curl -O http://localhost:9527/api/files/<文件名>.mp4
```
