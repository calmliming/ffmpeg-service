/** cancelled 和 completed、failed 一样是终态：进入终态后进度和状态都不会再变 */
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type TerminalStatus = 'completed' | 'failed' | 'cancelled';

export type TaskPhase =
  'downloading' | 'analyzing' | 'normalizing' | 'merging' | 'processing' | 'encoding' | 'uploading';

/** 任务产物。不含服务器本地路径 */
export interface TaskOutput {
  /** 产物在输出目录里的相对路径（正斜杠），多文件产物带子目录，如 3f2a…/index.m3u8 */
  name: string;
  /**
   * 下载地址：本地存储为 /api/files/…（配置了 PUBLIC_BASE_URL 时为绝对地址），S3 为公开地址或预签名链接。
   * 旧字段 downloadUrl 对本地产物始终是 /api/files/… 相对路径，不受 PUBLIC_BASE_URL 影响
   */
  url: string;
  size: number;
  contentType: string;
  storage: 'local' | 's3';
  /** S3 对象 key */
  key?: string;
}

/** 回调投递结果，任务进入终态并投递完 callbackUrl 后写入 */
export interface TaskCallback {
  delivered: boolean;
  attempts: number;
  /** 最后一次收到的 HTTP 状态码 */
  status?: number;
  error?: string;
  deliveredAt?: Date;
  /** 与回调请求头 X-FFmpeg-Service-Delivery 相同，接收方据此去重；排查「对方说没收到」时用它对日志 */
  deliveryId?: string;
}

/** pipeline 每一步的状态。失败或取消时，出事的那一步是 failed / cancelled，后面的步骤保持 pending */
export type PipelineStepStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface PipelineStep {
  /** 操作名 */
  op: string;
  status: PipelineStepStatus;
}

export interface Task {
  id: string;
  status: TaskStatus;
  /** 0-100 的整数 */
  progress: number;
  /** 操作名（transcode、trim…）；pipeline 任务为 pipeline */
  type: string;
  /** 只有 pipeline 任务有：每一步的操作名和状态 */
  steps?: PipelineStep[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /**
   * 旧字段：产物在输出目录里的相对路径（与 outputs[].name 相同），逗号分隔。新客户端用 outputs。
   * 升级前的记录里是服务器绝对路径，taskView 返回给客户端前会换成相对路径
   */
  output?: string;
  outputs?: TaskOutput[];
  /** 主产物的下载地址 */
  primaryUrl?: string;
  /** 分析类操作的结构化结果 */
  result?: unknown;
  error?: string;
  callbackUrl?: string;
  callback?: TaskCallback;
  currentVideoIndex?: number;
  totalVideos?: number;
  phase?: TaskPhase;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
