export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Task {
  id: string;
  status: TaskStatus;
  progress: number;
  type: string;
  createdAt: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
  inputFiles?: string[]; // 上传的临时文件路径，任务结束后清理
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface TranscodeOptions {
  format?: string;
  videoCodec?: string;
  audioCodec?: string;
  videoBitrate?: string;
  audioBitrate?: string;
  resolution?: string;
  fps?: number;
}

export interface TrimOptions {
  startTime: string; // "00:00:10"
  endTime?: string;
  duration?: number; // seconds
}

export interface WatermarkOptions {
  text?: string;
  image?: string;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  fontSize?: number;
  fontColor?: string;
}

export interface ScreenshotOptions {
  timestamps: string[]; // ["00:00:05", "00:00:10"]
}

export interface ThumbnailOptions {
  count?: number;
  size?: string; // "320x240"
}

export interface GifOptions {
  startTime?: string;
  duration?: number;
  width?: number;
  fps?: number;
}

export interface ComposeOptions {
  videos: string[];   // 视频 URL 列表
  music?: string;     // 背景音乐 URL（可选）
  musicVolume?: number; // 音乐音量 0-1，默认 1
  muteOriginalAudio?: boolean; // 是否消除视频原声，默认 false
}
