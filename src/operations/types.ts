import type { z } from 'zod';
import type { TaskPhase } from '../types';
import type { MediaSummary } from '../utils/media-probe';
import type { RunFFmpegResult } from '../utils/ffmpeg-run';

/**
 * 输入文件的类别，引擎据此过滤上传的扩展名 / MIME：
 * media = 视频或音频；subtitle = srt / ass / ssa / vtt；any = 以上全部
 */
export type InputKind = 'video' | 'audio' | 'image' | 'subtitle' | 'media' | 'any';

export interface InputSlot {
  /** multipart 文件字段名，也是 ctx.inputs 的 key */
  name: string;
  kind: InputKind;
  required: boolean;
  /** 多文件槽（如 merge 的 files）：上传时同名字段出现多次，URL 方式传数组 */
  multiple?: { min: number; max: number };
  /**
   * 以 URL 提交时的字段名。默认单文件槽为 `${name}Url`、多文件槽为 `${name}Urls`；
   * 名为 file 的槽额外接受 url。compose 这类历史接口用它保留原字段名（videos、music）
   */
  urlFields?: string[];
  /** 中文说明，生成文档用 */
  description: string;
}

export interface ProgressExtra {
  phase?: TaskPhase;
  currentVideoIndex?: number;
  totalVideos?: number;
}

export interface RunOptions {
  /** 这条命令预计输出的时长（秒）。给了才会把 ffmpeg 的 out_time 换算成进度 */
  duration?: number;
  /** 这条命令占本操作进度的区间，默认 [0, 1]。多条命令的操作按区间分段汇报 */
  range?: [number, number];
  logLevel?: 'error' | 'warning' | 'info';
  captureStderr?: boolean;
}

/** 操作执行时拿到的上下文。引擎和单元测试都通过 createOperationContext 创建 */
export interface OperationContext {
  readonly taskId: string;
  /** 本地输入文件的绝对路径，按槽名索引；单文件槽是长度为 1 的数组，未提供的可选槽不存在 */
  readonly inputs: Readonly<Record<string, readonly string[]>>;
  /** 本任务专用的临时目录，任务结束后整体删除；ffmpeg 默认在这里运行（cwd） */
  readonly workDir: string;
  readonly signal: AbortSignal;
  /** 在输出目录生成一个新文件路径（随机文件名）。ext 不带点，只能是 1-8 位小写字母数字 */
  outputPath(ext: string): string;
  /** 在输出目录建一个新子目录，用于 HLS、批量抽帧这类多文件产物 */
  outputDir(): Promise<string>;
  /** workDir 里的文件路径。name 只能含字母、数字、点、下划线、短横线 */
  tempPath(name: string): string;
  probe(file: string): Promise<MediaSummary>;
  /**
   * 运行 ffmpeg：自动带上取消信号，cwd 为 workDir；给了 duration 时自动汇报进度。
   * 一条命令有多个输出时 -progress 的 out_time 不可靠（FFmpeg 8.1 上所有输出都写出数据前是 N/A，之后跟随最慢的输出），
   * 需要旁路分析时用 split + nullsink 或单独一条命令
   */
  ffmpeg(args: string[], opts?: RunOptions): Promise<RunFFmpegResult>;
  /** 汇报本操作的进度，fraction 为 0-1 */
  progress(fraction: number, extra?: ProgressExtra): void;
  log(message: string): void;
}

export interface OperationResult {
  /** 产物的绝对路径，必须在 outputPath / outputDir 给出的位置 */
  files: string[];
  /** 主产物，pipeline 串联时作为下一步的输入；默认 files[0] */
  primary?: string;
  /** 分析类操作的结构化结果，原样放进任务详情的 result 字段 */
  data?: unknown;
}

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  /** 唯一名称：任务 type、BullMQ job 名、pipeline 的 op 名。历史接口沿用原名（transcode、trim…） */
  name: string;
  /** 完整路由，如 /api/transcode、/api/video/crop */
  route: string;
  /** 中文标题和说明，生成文档用 */
  title: string;
  description: string;
  inputs: InputSlot[];
  /**
   * 参数 schema。输入是 multipart 文本字段或 JSON body（已去掉文件、URL 和 callbackUrl 等通用字段），
   * 数字和布尔值可能是字符串，用 src/schemas/coerce.ts 的工具转换。每个字段用 .meta({ description }) 写中文说明
   */
  params: S;
  /** 同步接口：不排队，在请求里直接执行并返回 data（如 /api/info） */
  sync?: boolean;
  /**
   * 能否在 pipeline 中串联：主输入是名为 file 的单文件槽（接上一步的主产物），并且产出一个主文件。
   * 其他必填槽（如画中画的 overlay、配乐的 audio）由 pipeline 步骤的 inputs 用 URL 提供。createApp 启动时校验
   */
  chainable?: boolean;
  /** 有 URL 输入时，下载阶段占任务总进度的比例，默认 0.3（compose 沿用文档里的 0.55） */
  downloadShare?: number;
  /** curl 示例，生成文档用 */
  example?: string;
  /** 文档里的补充说明 */
  notes?: string[];
  /**
   * 跨字段校验，在入队前执行。provided 是每个输入槽实际收到的文件数（上传或 URL）。
   * 返回错误信息表示拒绝（400），返回 undefined 表示通过
   */
  check?(params: z.output<S>, provided: Readonly<Record<string, number>>): string | undefined;
  run(ctx: OperationContext, params: z.output<S>): Promise<OperationResult>;
}

export type AnyOperation = Operation<z.ZodObject>;

/** 只为类型推导：让 run / check 的 params 拿到 schema 的输出类型 */
export function defineOperation<S extends z.ZodObject>(op: Operation<S>): AnyOperation {
  return op as unknown as AnyOperation;
}
