# FFmpeg 参数说明

本文档整理本项目中使用到的 FFmpeg 参数，方便快速查阅和调整。

---

## 输入参数

| 参数 | 值 | 说明 |
|---|---|---|
| `-i` | 文件路径 / URL | 指定输入源 |
| `-reconnect` | `1` | HTTP 断线后自动重连 |
| `-reconnect_streamed` | `1` | 流式 HTTP 也允许重连 |
| `-reconnect_delay_max` | `5` | 最大重连等待秒数 |
| `-f concat` | — | 使用 concat demuxer，从文本文件读取输入列表 |
| `-safe` | `0` | concat 模式下允许使用绝对路径 |
| `-ss` / `-setStartTime` | `HH:MM:SS` | 从指定时间开始读取输入 |
| `-to` | `HH:MM:SS` | 读取到指定时间点 |

---

## 视频编码参数

| 参数 | 值 | 说明 |
|---|---|---|
| `-c:v` | `libx264` | 使用 H.264 编码器（兼容性最好） |
| `-c:v` | `copy` | 流复制，不重新编码（速度极快，无质量损失） |
| `-preset` | `ultrafast` | 编码速度最快，文件略大 |
| `-preset` | `veryfast` | 次快，本项目默认值 |
| `-preset` | `medium` | FFmpeg 默认，速度慢 3-5x |
| `-preset` | `slow` | 最慢，文件最小 |
| `-crf` | `18` | 接近无损，文件大 |
| `-crf` | `23` | 视觉无损，本项目默认值（libx264 官方默认） |
| `-crf` | `28` | 画质明显下降，文件小 |
| `-r` | `30` | 强制输出帧率 30fps |
| `-threads` | `2` | 限制编码线程数，防止 CPU 打满（2核服务器适用） |

---

## 音频编码参数

| 参数 | 值 | 说明 |
|---|---|---|
| `-c:a` | `aac` | 使用 AAC 编码器 |
| `-c:a` | `copy` | 音频流复制，不重新编码 |
| `-ar` | `44100` | 采样率 44100 Hz |
| `-ac` | `2` | 双声道（立体声） |
| `-an` | — | 去除音频轨（静音输出） |
| `-shortest` | — | 以最短的输入流为准截断输出 |

---

## 视频滤镜（-vf / -filter_complex）

### scale — 缩放

```
scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1
```

| 部分 | 说明 |
|---|---|
| `scale=1280:720` | 目标尺寸 |
| `force_original_aspect_ratio=decrease` | 等比缩小，不拉伸 |
| `pad=1280:720:(ow-iw)/2:(oh-ih)/2` | 不足的部分补黑边，居中 |
| `setsar=1` | 修正像素宽高比为 1:1，防止播放器显示变形 |

简单缩放（不保持比例）：
```
scale=iw:ih
```

### fps — 强制帧率

```
fps=10
```

配合 `scale` 用于生成 GIF：
```
fps=10,scale=320:-1:flags=lanczos
```

| 部分 | 说明 |
|---|---|
| `scale=320:-1` | 宽度 320，高度按比例自动计算 |
| `flags=lanczos` | 缩放算法，GIF 效果最好 |

### drawtext — 文字水印

```
drawtext=text='Hello':fontsize=24:fontcolor=white:x=w-tw-10:y=h-th-10
```

| 部分 | 说明 |
|---|---|
| `text=` | 水印文字 |
| `fontsize=` | 字号 |
| `fontcolor=` | 颜色，支持 `white` `yellow` `#RRGGBB` |
| `x=10:y=10` | 左上角 |
| `x=w-tw-10:y=10` | 右上角（`tw` = text width） |
| `x=10:y=h-th-10` | 左下角（`th` = text height） |
| `x=w-tw-10:y=h-th-10` | 右下角 |
| `x=(w-tw)/2:y=(h-th)/2` | 居中 |

### overlay — 图片水印

```
overlay=main_w-overlay_w-10:main_h-overlay_h-10
```

### concat — 拼接多路流

```
[v0][v1][v2]concat=n=3:v=1:a=0[outv]
```

| 参数 | 说明 |
|---|---|
| `n=3` | 输入片段数量 |
| `v=1` | 输出 1 路视频 |
| `a=0` | 不输出音频（单独处理） |

---

## 音频滤镜（-filter_complex）

### volume — 调整音量

```
[0:a]volume=0.6[outa]
```

`1` = 原始音量，`0.5` = 减半，`2` = 加倍。

### aresample — 重采样

```
[0:a]aresample=44100[a0]
```

统一采样率，避免拼接时格式不一致。

### amix — 混合多路音频

```
[0:a]volume=1[va];[1:a]volume=0.6[ba];[va][ba]amix=inputs=2:duration=first[outa]
```

| 部分 | 说明 |
|---|---|
| `inputs=2` | 混合 2 路音频 |
| `duration=first` | 以第一路音频时长为准截断 |

---

## 输出控制参数

| 参数 | 说明 |
|---|---|
| `-map 0:v` | 选取第 0 个输入的视频流 |
| `-map [outv]` | 选取 filter_complex 输出的视频流 |
| `-map [outa]` | 选取 filter_complex 输出的音频流 |
| `-y` | 输出文件已存在时直接覆盖 |

---

## compose 接口完整流程示意

```
输入：N 个视频 URL + 1 个音乐 URL

Step 1: 逐个转码（内存峰值 ~100MB）
  每个视频 URL
    → ffmpeg -i URL -vf scale=1280:720... -c:v libx264 -preset veryfast -crf 23 -threads 2 seg_N.mp4

Step 2: 流复制拼接（内存极低）
  concat.txt:
    file 'seg_0.mp4'
    file 'seg_1.mp4'
    ...
  → ffmpeg -f concat -safe 0 -i concat.txt -c copy merged.mp4

Step 3: 混入背景音乐
  → ffmpeg -i merged.mp4 -i music.mp3
      -filter_complex "[0:a]volume=1[va];[1:a]volume=0.6[ba];[va][ba]amix=inputs=2:duration=first[outa]"
      -map 0:v -map [outa] -c:v copy -c:a aac -shortest output.mp4
```
