import { spawn } from 'child_process';
import { config } from '../config';
import { redactPaths } from './redact';

export interface RunFFmpegOptions {
  /** ffmpeg 每次汇报进度时回调当前已输出的时长（秒） */
  onTime?: (seconds: number) => void;
  /** 取消任务时直接杀掉 ffmpeg 进程，Promise 以 signal.reason 拒绝 */
  signal?: AbortSignal;
  /**
   * 工作目录。滤镜参数里要引用的文件（字幕、drawtext 的 textfile 等）放在这里并只写文件名：
   * 滤镜语法里冒号、反斜杠、单引号都要多层转义，Windows 盘符 C:\ 尤其容易出错，只写文件名就绕开了
   */
  cwd?: string;
  /** 默认 error。silencedetect、ebur128 这类分析滤镜的结果打在 info 级别，要解析时传 info */
  logLevel?: 'error' | 'warning' | 'info';
  /** 返回完整的 stderr（上限 32 MB），用来解析分析类滤镜的输出；默认只保留最后 4000 字符用于报错 */
  captureStderr?: boolean;
}

export interface RunFFmpegResult {
  stderr: string;
}

const MAX_CAPTURED_STDERR = 32 * 1024 * 1024;

/**
 * 运行 ffmpeg。进度走 -progress pipe:1 的机器可读输出，stderr 默认只保留 error 级日志，
 * 这样失败时抛出的错误就是真正的原因，而不是版本横幅和流信息。
 */
export function runFFmpeg(args: string[], opts: RunFFmpegOptions = {}): Promise<RunFFmpegResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason);

    const proc = spawn(
      config.ffmpegPath,
      [
        '-hide_banner',
        '-nostats',
        '-nostdin',
        '-loglevel',
        opts.logLevel ?? 'error',
        '-progress',
        'pipe:1',
        ...args,
      ],
      { windowsHide: true, cwd: opts.cwd },
    );

    let stderr = '';
    let pending = '';
    let aborted = false;
    proc.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line.trim());
        if (match) opts.onTime?.(Number(match[1]) / 1e6);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (opts.captureStderr) {
        if (stderr.length < MAX_CAPTURED_STDERR) stderr += chunk.toString();
      } else {
        stderr = (stderr + chunk.toString()).slice(-4000);
      }
    });

    const onAbort = () => {
      aborted = true;
      proc.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`无法启动 FFmpeg（${config.ffmpegPath}）: ${err.message}`));
    });
    proc.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (aborted) return reject(opts.signal?.reason ?? new Error('任务已取消'));
      if (code === 0) return resolve({ stderr });
      const detail = redactPaths(
        stderr.trim().split(/\r?\n/).slice(-6).join(' | '),
        opts.cwd ? [opts.cwd] : [],
      );
      reject(
        new Error(detail || (signal ? `FFmpeg 被信号 ${signal} 终止` : `FFmpeg 退出码 ${code}`)),
      );
    });
  });
}
