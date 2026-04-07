import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { taskService } from './task.service';
import { execFile } from 'child_process';
import type { TranscodeOptions, TrimOptions, WatermarkOptions, ScreenshotOptions, ThumbnailOptions, GifOptions, ComposeOptions } from '../types';

ffmpeg.setFfmpegPath(config.ffmpegPath);
ffmpeg.setFfprobePath(config.ffprobePath);

function outputPath(ext: string): string {
  return path.join(config.outputDir, `${uuidv4()}.${ext}`);
}

function runWithProgress(command: ffmpeg.FfmpegCommand, taskId: string): Promise<string> {
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
      cmd.videoFilters(`drawtext=text='${options.text}':fontsize=${fontSize}:fontcolor=${fontColor}:${pos}`);
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
   * 合成视频：将多个在线视频 URL 拼接，并可叠加背景音乐
   * 直接使用在线 URL，无需下载
   */
  async compose(taskId: string, options: ComposeOptions): Promise<string> {
    const out = outputPath('mp4');
    const { videos, music, musicVolume = 1 } = options;

    taskService.update(taskId, { status: 'processing', progress: 0 });

    return new Promise((resolve, reject) => {
      // 构建 ffmpeg 命令参数
      const args: string[] = [];

      // 添加所有视频输入（对 HTTP 源增加重连和完整读取参数）
      for (const url of videos) {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          args.push(
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
          );
        }
        args.push('-i', url);
      }

      // 构建 filter_complex
      const n = videos.length;
      let filterParts: string[] = [];
      let concatInputs = '';

      // 统一视频分辨率并拼接，setpts 重置每段时间戳防止丢帧
      for (let i = 0; i < n; i++) {
        filterParts.push(`[${i}:v]scale=iw:ih,setsar=1,setpts=PTS-STARTPTS[v${i}]`);
        concatInputs += `[v${i}]`;
      }
      filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=0[outv]`);

      if (music) {
        // 有背景音乐：添加音乐输入，混合后截断到视频长度
        args.push('-i', music);
        const musicIdx = n;
        filterParts.push(`[${musicIdx}:a]volume=${musicVolume}[bgm]`);

        // 同时拼接原始视频音频
        let audioConcat = '';
        for (let i = 0; i < n; i++) {
          filterParts.push(`[${i}:a]aresample=44100,asetpts=PTS-STARTPTS[a${i}]`);
          audioConcat += `[a${i}]`;
        }
        filterParts.push(`${audioConcat}concat=n=${n}:v=0:a=1[origa]`);
        // 混合原始音频和背景音乐，以视频音频时长为准
        filterParts.push(`[origa][bgm]amix=inputs=2:duration=first[outa]`);

        args.push('-filter_complex', filterParts.join(';'));
        args.push('-map', '[outv]', '-map', '[outa]');
      } else {
        // 无背景音乐：拼接视频和音频
        let audioConcat = '';
        for (let i = 0; i < n; i++) {
          filterParts.push(`[${i}:a]aresample=44100,asetpts=PTS-STARTPTS[a${i}]`);
          audioConcat += `[a${i}]`;
        }
        filterParts.push(`${audioConcat}concat=n=${n}:v=0:a=1[outa]`);

        args.push('-filter_complex', filterParts.join(';'));
        args.push('-map', '[outv]', '-map', '[outa]');
      }

      args.push('-c:v', 'libx264', '-c:a', 'aac', '-y', out);

      console.log(`[FFmpeg Compose] ffmpeg ${args.join(' ')}`);

      const proc = execFile(config.ffmpegPath, args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) {
          console.error(`[FFmpeg Compose Error] ${stderr}`);
          taskService.update(taskId, { status: 'failed', error: err.message });
          reject(err);
        } else {
          taskService.update(taskId, { status: 'completed', progress: 100, output: out });
          resolve(out);
        }
      });

      // 解析进度（从 stderr 中读取 time=）
      proc.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        const match = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (match) {
          const seconds = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
          // 粗略进度（假设总时长 = 视频数 * 8 秒）
          const estimated = videos.length * 8;
          const progress = Math.min(99, Math.round((seconds / estimated) * 100));
          taskService.update(taskId, { progress });
        }
      });
    });
  },
};
