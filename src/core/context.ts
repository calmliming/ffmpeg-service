import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { probeMedia } from '../utils/media-probe';
import { runFFmpeg } from '../utils/ffmpeg-run';
import type { OperationContext, ProgressExtra } from '../operations/types';

export interface CreateContextOptions {
  taskId: string;
  inputs: Record<string, string[]>;
  /** 调用方负责创建和删除 */
  workDir: string;
  /** 产物根目录，默认 config.outputDir */
  outputRoot?: string;
  signal: AbortSignal;
  onProgress?: (fraction: number, extra?: ProgressExtra) => void;
  onLog?: (message: string) => void;
}

export interface CreatedContext extends OperationContext {
  /** 本次执行通过 outputPath / outputDir 分配的产物位置，失败时由调用方删除 */
  readonly allocated: readonly string[];
}

const EXT = /^[a-z0-9]{1,8}$/;
const TEMP_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function createOperationContext(opts: CreateContextOptions): CreatedContext {
  const outputRoot = opts.outputRoot ?? config.outputDir;
  const allocated: string[] = [];
  const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  const report = (fraction: number, extra?: ProgressExtra) =>
    opts.onProgress?.(clamp(fraction), extra);

  return {
    taskId: opts.taskId,
    inputs: opts.inputs,
    workDir: opts.workDir,
    signal: opts.signal,
    allocated,

    outputPath(ext) {
      // 扩展名进了文件名就是路径的一部分，必须是白名单字符，防止 ../ 之类写到输出目录外
      if (!EXT.test(ext)) throw new Error(`非法的输出扩展名: ${ext}`);
      const file = path.join(outputRoot, `${uuidv4()}.${ext}`);
      allocated.push(file);
      return file;
    },

    async outputDir() {
      const dir = path.join(outputRoot, uuidv4());
      await fs.promises.mkdir(dir, { recursive: true });
      allocated.push(dir);
      return dir;
    },

    tempPath(name) {
      if (!TEMP_NAME.test(name) || name.includes('..'))
        throw new Error(`非法的临时文件名: ${name}`);
      return path.join(opts.workDir, name);
    },

    probe(file) {
      return probeMedia(file, opts.signal);
    },

    async ffmpeg(args, runOpts = {}) {
      const [start, end] = runOpts.range ?? [0, 1];
      const duration = runOpts.duration;
      const result = await runFFmpeg(args, {
        cwd: opts.workDir,
        signal: opts.signal,
        logLevel: runOpts.logLevel,
        captureStderr: runOpts.captureStderr,
        onTime:
          duration && duration > 0
            ? (t) => report(start + Math.min(t / duration, 1) * (end - start))
            : undefined,
      });
      // 短素材 ffmpeg 可能只汇报一两次，最后的 out_time 也比时长少一帧，命令结束时补齐到区间终点
      report(end);
      return result;
    },

    progress: report,

    log(message) {
      if (opts.onLog) opts.onLog(message);
      else console.log(`[Task:${opts.taskId}] ${message}`);
    },
  };
}
