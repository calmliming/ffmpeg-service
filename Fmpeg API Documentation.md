# FFmpeg Service 接口文档

## 概述

FFmpeg Service 是一个基于 Node.js/TypeScript 的 RESTful API 服务，将 FFmpeg 的常用功能封装为 HTTP 接口，支持视频转码、剪辑、处理、在线合成等功能。

- **基础地址**: `http://localhost:9527`
- **最大上传文件**: 500MB
- **支持格式**: video/\*、audio/\*、image/\*

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式启动
pnpm dev

# 生产构建 & 启动
pnpm build
pnpm start
```

## 统一响应格式

```json
{
  "success": true,
  "data": { ... }
}
```

错误响应：

```json
{
  "success": false,
  "error": "错误信息"
}
```

## 异步任务机制

所有耗时操作（转码、剪辑、合成等）均为异步处理：

1. 提交请求 → 立即返回 `taskId`
2. 通过 **轮询** 或 **SSE** 获取任务进度
3. 任务完成后通过 `downloadUrl` 下载结果文件

---

## 接口列表

### 1. 健康检查

**`GET /api/health`**

检查服务运行状态和 FFmpeg 可用性。

**请求示例：**

```bash
curl http://localhost:9527/api/health
```

**响应示例：**

```json
{
  "success": true,
  "data": {
    "service": "ffmpeg-service",
    "status": "running",
    "ffmpeg": "available",
    "timestamp": "2026-04-02T08:00:00.000Z"
  }
}
```

---

### 2. 获取媒体信息

**`POST /api/info`**

获取音视频文件的元信息（时长、分辨率、编码、码率等）。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 音视频文件 |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/info \
  -F "file=@video.mp4"
```

**响应示例：**

```json
{
  "success": true,
  "data": {
    "streams": [
      {
        "codec_name": "h264",
        "width": 1920,
        "height": 1080,
        "duration": "10.000000"
      }
    ],
    "format": {
      "duration": "10.000000",
      "size": "5242880",
      "bit_rate": "4194304"
    }
  }
}
```

---

### 3. 视频转码 / 格式转换

**`POST /api/transcode`**

将视频转换为其他格式，支持自定义编码器、码率、分辨率等。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 视频文件 |
| format | string | 否 | 输出格式，默认 `mp4`（可选 `webm`、`avi`、`mkv` 等） |
| videoCodec | string | 否 | 视频编码器（如 `libx264`、`libvpx`） |
| audioCodec | string | 否 | 音频编码器（如 `aac`、`libmp3lame`） |
| videoBitrate | string | 否 | 视频码率（如 `1000k`） |
| audioBitrate | string | 否 | 音频码率（如 `128k`） |
| resolution | string | 否 | 分辨率（如 `1280x720`） |
| fps | number | 否 | 帧率 |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/transcode \
  -F "file=@video.mp4" \
  -F "format=webm" \
  -F "resolution=1280x720" \
  -F "videoBitrate=1000k"
```

**响应示例：**

```json
{
  "success": true,
  "data": {
    "taskId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending"
  }
}
```

---

### 4. 视频裁剪

**`POST /api/edit/trim`**

按时间段裁剪视频。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 视频文件 |
| startTime | string | 是 | 起始时间，格式 `HH:MM:SS`（如 `00:00:05`） |
| endTime | string | 否 | 结束时间，格式 `HH:MM:SS` |
| duration | number | 否 | 持续秒数（与 endTime 二选一） |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/edit/trim \
  -F "file=@video.mp4" \
  -F "startTime=00:00:05" \
  -F "duration=10"
```

---

### 5. 视频拼接

**`POST /api/edit/merge`**

将多个视频文件拼接为一个。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| files | File[] | 是 | 视频文件列表（2-10 个） |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/edit/merge \
  -F "files=@video1.mp4" \
  -F "files=@video2.mp4" \
  -F "files=@video3.mp4"
```

---

### 6. 提取音频

**`POST /api/edit/extract-audio`**

从视频中提取音频轨道。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 视频文件 |
| format | string | 否 | 音频格式，默认 `mp3`（可选 `aac`、`wav`、`flac`） |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/edit/extract-audio \
  -F "file=@video.mp4" \
  -F "format=wav"
```

---

### 7. 添加水印

**`POST /api/process/watermark`**

为视频添加文字水印或图片水印。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 视频文件 |
| text | string | 否 | 文字水印内容（与 image 二选一） |
| image | File | 否 | 图片水印文件（与 text 二选一） |
| position | string | 否 | 水印位置，默认 `bottom-right` |
| fontSize | number | 否 | 文字大小，默认 `24` |
| fontColor | string | 否 | 文字颜色，默认 `white` |

**position 可选值：**
`top-left`、`top-right`、`bottom-left`、`bottom-right`、`center`

**请求示例：**

```bash
# 文字水印
curl -X POST http://localhost:9527/api/process/watermark \
  -F "file=@video.mp4" \
  -F "text=Hello World" \
  -F "position=top-right" \
  -F "fontSize=36" \
  -F "fontColor=yellow"

# 图片水印
curl -X POST http://localhost:9527/api/process/watermark \
  -F "file=@video.mp4" \
  -F "image=@logo.png" \
  -F "position=bottom-right"
```

---

### 8. 视频截图

**`POST /api/process/screenshot`**

在指定时间点截取视频画面。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 视频文件 |
| timestamps | string | 是 | 截图时间点，逗号分隔（如 `00:00:05,00:00:10`） |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/process/screenshot \
  -F "file=@video.mp4" \
  -F "timestamps=00:00:02,00:00:05,00:00:08"
```

---

### 9. 生成缩略图

**`POST /api/process/thumbnail`**

自动从视频中均匀截取多张缩略图。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 视频文件 |
| count | number | 否 | 缩略图数量，默认 `6` |
| size | string | 否 | 缩略图尺寸，默认 `320x240` |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/process/thumbnail \
  -F "file=@video.mp4" \
  -F "count=8" \
  -F "size=640x360"
```

---

### 10. 视频转 GIF

**`POST /api/process/gif`**

将视频片段转换为 GIF 动图。

**请求方式：** `multipart/form-data`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 视频文件 |
| startTime | string | 否 | 起始时间（如 `00:00:02`） |
| duration | number | 否 | 持续秒数 |
| width | number | 否 | GIF 宽度，默认 `320`（高度自适应） |
| fps | number | 否 | 帧率，默认 `10` |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/process/gif \
  -F "file=@video.mp4" \
  -F "startTime=00:00:02" \
  -F "duration=5" \
  -F "width=480" \
  -F "fps=15"
```

---

### 11. 在线视频合成（+ 背景音乐）

**`POST /api/compose`**

将多个在线视频 URL 拼接合成，并可叠加背景音乐。无需下载文件，直接传入 URL。

**请求方式：** `application/json`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| videos | string[] | 是 | 视频 URL 列表 |
| music | string | 否 | 背景音乐 URL |
| musicVolume | number | 否 | 音乐音量，范围 `0-1`，默认 `1` |
| muteOriginalAudio | boolean | 否 | 是否消除视频原声，默认 `false` |

**请求示例：**

```bash
curl -X POST http://localhost:9527/api/compose \
  -H "Content-Type: application/json" \
  -d '{
    "videos": [
      "https://example.com/video1.mp4",
      "https://example.com/video2.mp4",
      "https://example.com/video3.mp4"
    ],
    "music": "https://example.com/bgm.mp3",
    "musicVolume": 0.8
  }'
```

**响应示例：**

```json
{
  "success": true,
  "data": {
    "taskId": "649ec3c6-8033-4b6b-9d46-a0a2123dcdd2",
    "status": "pending"
  }
}
```

**说明：**
- 视频会自动统一缩放至 1280x720 分辨率
- 默认原始视频音频与背景音乐自动混合
- 设置 `muteOriginalAudio: true` 可消除视频原声，仅保留背景音乐
- 输出时长以视频总时长为准（音乐不够会自动结束，音乐过长会截断）

---

### 12. 查询任务状态

**`GET /api/tasks/:id`**

查询异步任务的当前状态和进度。

**请求示例：**

```bash
curl http://localhost:9527/api/tasks/649ec3c6-8033-4b6b-9d46-a0a2123dcdd2
```

**响应示例：**

```json
{
  "success": true,
  "data": {
    "id": "649ec3c6-8033-4b6b-9d46-a0a2123dcdd2",
    "status": "completed",
    "progress": 100,
    "type": "compose",
    "createdAt": "2026-04-02T10:25:26.368Z",
    "completedAt": "2026-04-02T10:26:05.422Z",
    "elapsedSeconds": 39,
    "currentVideoIndex": 5,
    "totalVideos": 5,
    "output": "/path/to/output.mp4",
    "downloadUrl": ["/api/files/output.mp4"]
  }
}
```

**响应字段说明：**

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `progress` | number | 合并进度 0-100 |
| `elapsedSeconds` | number | 从开始处理到现在已耗时（秒），完成后为总耗时 |
| `currentVideoIndex` | number | 当前正在合并第几条视频（仅 compose 任务） |
| `totalVideos` | number | 本次合并视频总数（仅 compose 任务） |

**任务状态说明：**

| 状态 | 说明 |
|------|------|
| `pending` | 等待处理 |
| `processing` | 处理中 |
| `completed` | 已完成，可通过 `downloadUrl` 下载 |
| `failed` | 失败，查看 `error` 字段 |

---

### 13. SSE 实时进度推送

**`GET /api/tasks/:id/progress`**

通过 Server-Sent Events 实时获取任务进度，适合前端实时展示进度条。

**请求示例：**

```bash
curl -N http://localhost:9527/api/tasks/649ec3c6-8033-4b6b-9d46-a0a2123dcdd2/progress
```

**推送数据格式：**

```
data: {"id":"649ec3c6-...","status":"processing","progress":45,"type":"compose"}

data: {"id":"649ec3c6-...","status":"completed","progress":100,"type":"compose","output":"..."}
```

**前端使用示例：**

```javascript
const es = new EventSource('/api/tasks/your-task-id/progress');
es.onmessage = (event) => {
  const task = JSON.parse(event.data);
  console.log(`进度: ${task.progress}%`);
  if (task.status === 'completed' || task.status === 'failed') {
    es.close();
  }
};
```

---

### 14. 下载输出文件

**`GET /api/files/:filename`**

下载处理完成后的输出文件。文件路径从任务查询接口的 `downloadUrl` 字段获取。

**请求示例：**

```bash
curl -O http://localhost:9527/api/files/output-abc123.mp4
```

---

## 完整使用流程示例

以「在线合成视频 + 背景音乐」为例：

```bash
# 1. 提交合成任务
RESPONSE=$(curl -s -X POST http://localhost:9527/api/compose \
  -H "Content-Type: application/json" \
  -d '{
    "videos": [
      "https://example.com/video1.mp4",
      "https://example.com/video2.mp4"
    ],
    "music": "https://example.com/bgm.mp3"
  }')

echo $RESPONSE
# {"success":true,"data":{"taskId":"abc-123","status":"pending"}}

# 2. 轮询任务进度
curl http://localhost:9527/api/tasks/abc-123
# {"success":true,"data":{"status":"processing","progress":65,...}}

# 3. 任务完成后下载
curl -O http://localhost:9527/api/files/output-abc-123.mp4
```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `9527` |
