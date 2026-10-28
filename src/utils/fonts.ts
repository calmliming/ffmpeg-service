import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface FontChoice {
  /** 字体文件绝对路径 */
  file?: string;
  /** fontconfig / libass 用的字体族名 */
  name?: string;
}

// Windows 上的 FFmpeg 构建通常没有 fontconfig 配置，不指定字体文件时 drawtext 直接失败；本地开发默认用微软雅黑
const WINDOWS_FALLBACKS = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf'];

/** 当前配置的字体：FONT_FILE / FONT_NAME；都没设时在 Windows 上退回系统中文字体 */
export function configuredFont(): FontChoice {
  const choice: FontChoice = {};
  if (config.fontFile) choice.file = config.fontFile;
  if (config.fontName && /^[\w .-]{1,64}$/.test(config.fontName)) choice.name = config.fontName;
  if (!choice.file && !choice.name && process.platform === 'win32') {
    choice.file = WINDOWS_FALLBACKS.find((f) => fs.existsSync(f));
  }
  return choice;
}

/**
 * 把字体文件放进 workDir 并返回文件名。滤镜参数里的路径要转义冒号、反斜杠和引号，
 * 放进 ffmpeg 的工作目录后只写文件名就不需要转义。优先硬链接，跨盘时退回复制
 */
export async function stageFontFile(file: string, workDir: string): Promise<string> {
  const name = `font${
    path
      .extname(file)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '') || '.ttf'
  }`;
  const dest = path.join(workDir, name);
  if (fs.existsSync(dest)) return name;
  try {
    await fs.promises.link(file, dest);
  } catch {
    await fs.promises.copyFile(file, dest);
  }
  return name;
}

/**
 * drawtext 的字体参数片段：`fontfile=font.ttc`、`font=Noto Sans CJK SC` 或空串（用 FFmpeg 默认字体）。
 * ffmpeg 必须以 workDir 为 cwd 运行（ctx.ffmpeg 默认如此）
 */
export async function drawtextFontOption(workDir: string): Promise<string> {
  const font = configuredFont();
  if (font.file) return `fontfile=${await stageFontFile(font.file, workDir)}`;
  if (font.name) return `font=${font.name.replace(/ /g, '\\ ')}`;
  return '';
}
