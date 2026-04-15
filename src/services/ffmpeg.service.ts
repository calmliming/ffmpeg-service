import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { taskService } from './task.service';
import { execFile } from 'child_process';
import type { TranscodeOptions, TrimOptions, WatermarkOptions, ScreenshotOptions, ThumbnailOptions, GifOptions, ComposeOptions } from '../types';

ffmpeg.setFfmpegPath(config.ffmpegPath);
ffmpeg.setFfprobePath(config.ffprobePath);

/** 转义 drawtext filter 中的特殊字符，防止命令注入 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\\\:')
    .replace(/%/g, '%%');
}

function outputPath(ext: string): string {
  return path.join(config.outputDir, `${uuidv4()}.${ext}`);
}

/** 执行 ffmpeg 命令，返回 Promise */
function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(config.ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        console.error(`[FFmpeg Error] ${(stderr ?? '').slice(-1000)}`);
        reject(new Error(err.message + '\n' + (stderr ?? '').slice(-500)));
      } else {
        resolve();
      }
    });
  });
}

async function runWithProgress(command: ffmpeg.FfmpegCommand, taskId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    command
      .on('start', (cmd: string) => {
        console.log(`[FFmpeg] ${cmd}`);
        taskService.update(taskId, { status: 'processing', progress: 0 });
      })
      .on('progress', (p: { percent?: number }) => {
        const progress = Math.round(p.percent ?? 0);
        taskService.update(taskId, { progress });
      })
      .on('end', () => {
        taskService.update(taskId, { status: 'completed', progress: 100, output });
        resolve(output);
      })
      .on('error', (err: Error) => {
        taskService.update(taskId, { status: 'failed', error: err.message });
        reject(err);
      });

    // Extract output path from the command
    const outputOptions = (command as any)._outputs;
    if (outputOptions?.length > 0) {
      output = outputOptions[0].target;
    }

    command.run();
  });
}

export const ffmpegService = {
  getInfo(inputPath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  },

  async transcode(inputPath: string, taskId: string, options: TranscodeOptions = {}): Promise<string> {
    const ext = options.format || 'mp4';
    const out = outputPath(ext);
    const cmd = ffmpeg(inputPath).output(out);

    if (options.videoCodec) cmd.videoCodec(options.videoCodec);
    if (options.audioCodec) cmd.audioCodec(options.audioCodec);
    if (options.videoBitrate) cmd.videoBitrate(options.videoBitrate);
    if (options.audioBitrate) cmd.audioBitrate(options.audioBitrate);
    if (options.resolution) cmd.size(options.resolution);
    if (options.fps) cmd.fps(options.fps);

    return runWithProgress(cmd, taskId);
  },

  async trim(inputPath: string, taskId: string, options: TrimOptions): Promise<string> {
    const ext = path.extname(inputPath).slice(1) || 'mp4';
    const out = outputPath(ext);
    const cmd = ffmpeg(inputPath).output(out).setStartTime(options.startTime);

    if (options.endTime) {
      cmd.inputOptions([`-to ${options.endTime}`]);
    } else if (options.duration) {
      cmd.setDuration(options.duration);
    }

    return runWithProgress(cmd, taskId);
  },

  async merge(inputPaths: string[], taskId: string): Promise<string> {
    const out = outputPath('mp4');
    const cmd = ffmpeg();

    for (const input of inputPaths) {
      cmd.input(input);
    }
    cmd.mergeToFile(out, config.uploadDir);

    return runWithProgress(cmd, taskId);
  },

  async extractAudio(inputPath: string, taskId: string, format = 'mp3'): Promise<string> {
    const out = outputPath(format);
    const cmd = ffmpeg(inputPath).output(out).noVideo();

    return runWithProgress(cmd, taskId);
  },

  async watermark(inputPath: string, taskId: string, options: WatermarkOptions): Promise<string> {
    const out = outputPath('mp4');
    const cmd = ffmpeg(inputPath).output(out);

    if (options.text) {
      const fontSize = options.fontSize || 24;
      const fontColor = options.fontColor || 'white';
      const posMap: Record<string, string> = {
        'top-left': 'x=10:y=10',
        'top-right': 'x=w-tw-10:y=10',
        'bottom-left': 'x=10:y=h-th-10',
        'bottom-right': 'x=w-tw-10:y=h-th-10',
        'center': 'x=(w-tw)/2:y=(h-th)/2',
      };
      const pos = posMap[options.position || 'bottom-right'];
      cmd.videoFilters(`drawtext=text='${escapeDrawtext(options.text)}':fontsize=${fontSize}:fontcolor=${fontColor}:${pos}`);
    } else if (options.image) {
      const posMap: Record<string, string> = {
        'top-left': 'overlay=10:10',
        'top-right': 'overlay=main_w-overlay_w-10:10',
        'bottom-left': 'overlay=10:main_h-overlay_h-10',
        'bottom-right': 'overlay=main_w-overlay_w-10:main_h-overlay_h-10',
        'center': 'overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2',
      };
      cmd.input(options.image);
      cmd.complexFilter(posMap[options.position || 'bottom-right']);
    }

    return runWithProgress(cmd, taskId);
  },

  async screenshot(inputPath: string, taskId: string, options: ScreenshotOptions): Promise<string[]> {
    const folder = config.outputDir;
    const filename = uuidv4();

    taskService.update(taskId, { status: 'processing', progress: 0 });

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: options.timestamps,
          filename: `${filename}-%i.png`,
          folder,
        })
        .on('end', () => {
          const files = options.timestamps.map((_, i) => path.join(folder, `${filename}-${i + 1}.png`));
          taskService.update(taskId, { status: 'completed', progress: 100, output: files.join(',') });
          resolve(files);
        })
        .on('error', (err: Error) => {
          taskService.update(taskId, { status: 'failed', error: err.message });
          reject(err);
        });
    });
  },

  async thumbnail(inputPath: string, taskId: string, options: ThumbnailOptions = {}): Promise<string[]> {
    const folder = config.outputDir;
    const filename = uuidv4();
    const count = options.count || 6;
    const size = options.size || '320x240';

    taskService.update(taskId, { status: 'processing', progress: 0 });

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          count,
          filename: `${filename}-%i.png`,
          folder,
          size,
        })
        .on('end', () => {
          const files = Array.from({ length: count }, (_, i) => path.join(folder, `${filename}-${i + 1}.png`));
          taskService.update(taskId, { status: 'completed', progress: 100, output: files.join(',') });
          resolve(files);
        })
        .on('error', (err: Error) => {
          taskService.update(taskId, { status: 'failed', error: err.message });
          reject(err);
        });
    });
  },

  async toGif(inputPath: string, taskId: string, options: GifOptions = {}): Promise<string> {
    const out = outputPath('gif');
    const width = options.width || 320;
    const fps = options.fps || 10;
    const cmd = ffmpeg(inputPath).output(out);

    if (options.startTime) cmd.setStartTime(options.startTime);
    if (options.duration) cmd.setDuration(options.duration);
    cmd.videoFilters(`fps=${fps},scale=${width}:-1:flags=lanczos`);
    cmd.noAudio();

    return runWithProgress(cmd, taskId);
  },

  /**
   * 合成视频：将多个在线视频 URL 拼接，并可叠加背景音乐。
   *
   * 采用"分段转码 + concat demuxer"策略，解决低内存服务器崩溃问题：
   * 1. 每次只处理 1 个视频片段，转码到本地临时文件（控制内存峰值）
   * 2. 用 -f concat -c copy 拼接所有片段（流复制，几乎不占内存）
   * 3. 最后单独混入背景音乐
   */
  async compose(taskId: string, options: ComposeOptions): Promise<string> {
    const { videos, music, musicVolume = 1, muteOriginalAudio = false } = options;
    const out = outputPath('mp4');

    taskService.update(taskId, { status: 'processing', progress: 0 });

    let concatFile = '';
    let mergedFile = '';

    try {
      // Step 1: 写 concat 列表，直接引用原始 URL，流复制拼接
      concatFile = path.join(config.outputDir, `${uuidv4()}_concat.txt`);
      const concatLines = ['ffconcat version 1.0', ...videos.map(url => `file '${url}'`)];
      fs.writeFileSync(concatFile, concatLines.join('\n'));
      taskService.update(taskId, { progress: 10 });

      mergedFile = path.join(config.outputDir, `${uuidv4()}_merged.mp4`);
      await runFFmpeg(['-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-i', concatFile, '-c', 'copy', '-y', mergedFile]);
      taskService.update(taskId, { progress: 75 });

      // Step 3: 混入背景音乐（或直接输出）
      if (music) {
        const audioArgs: string[] = ['-i', mergedFile];
        if (music.startsWith('http://') || music.startsWith('https://')) {
          audioArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        }
        audioArgs.push('-i', music);

        if (muteOriginalAudio) {
          audioArgs.push(
            '-filter_complex', `[1:a]volume=${musicVolume}[outa]`,
            '-map', '0:v', '-map', '[outa]',
          );
        } else {
          audioArgs.push(
            '-filter_complex', `[0:a]volume=1[va];[1:a]volume=${musicVolume}[ba];[va][ba]amix=inputs=2:duration=first[outa]`,
            '-map', '0:v', '-map', '[outa]',
          );
        }
        audioArgs.push('-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y', out);
        await runFFmpeg(audioArgs);
      } else {
        fs.renameSync(mergedFile, out);
        mergedFile = ''; // 不再删除，已移动到最终输出
      }

      taskService.update(taskId, { status: 'completed', progress: 100, output: out });
      return out;
    } catch (err: any) {
      taskService.update(taskId, { status: 'failed', error: err.message });
      throw err;
    } finally {
      if (concatFile) fs.unlink(concatFile, () => {});
      if (mergedFile) fs.unlink(mergedFile, () => {});
    }
  },
};
