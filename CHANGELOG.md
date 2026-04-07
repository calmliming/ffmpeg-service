# 更新日志

## [1.1.0] - 2026-04-07

### 新增
- 支持 `.env.local` 环境变量配置（通过 dotenv）
- `FFMPEG_PATH` / `FFPROBE_PATH` 可通过环境变量自定义 FFmpeg 路径
- `SAVE_OUTPUT_FILE` 开关，设为 `false` 时输出文件下载后自动清理

### 优化
- Compose 合成：HTTP 视频源增加 `-reconnect` 重连参数，防止网络中断
- Compose 合成：视频拼接使用 `setpts=PTS-STARTPTS` 重置时间戳，防止丢帧
- Compose 合成：音频统一 `aresample=44100` + `asetpts=PTS-STARTPTS` 处理
- Compose 合成：无背景音乐时也正确进行音频重采样

### 修复
- `execFile` 调用改用 `config.ffmpegPath`，修复 compose 中 FFmpeg 路径硬编码问题

## [1.0.0] - 2026-04-07

### 新增
- FFmpeg 服务第一版
- 视频转码、裁剪、拼接
- 提取音频
- 添加水印（文字/图片）
- 视频截图、缩略图生成
- 视频转 GIF
- 在线视频合成 + 背景音乐
- 任务状态查询 + SSE 实时进度推送
