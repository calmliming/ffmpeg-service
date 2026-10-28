import path from 'path';
import { config } from '../config';

// 绝对路径的目录部分：Windows 盘符或 / 开头、至少一级目录。前面是字母数字、冒号或斜杠时不算（排除 URL 里的 //host/a/b），
// 以 /api/ 开头的是错误信息里提到的接口地址（「纯音频请用 /api/audio/normalize」），不是文件路径
const ABSOLUTE_DIR = /(?<![\w:/\\])(?:[A-Za-z]:)?[\\/](?!api[\\/])(?:[^\\/\s'"|:*?<>]+[\\/])+/g;
const SEGMENT = String.raw`[^\\/\s'"|:*?<>]+`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 去掉错误信息里服务器文件的目录部分，只留文件名。ffmpeg / ffprobe 报错时以输入文件的绝对路径开头，
 * 原样返回给客户端（任务 error、回调、/api/info）会暴露安装目录和目录结构。
 * 已知目录（上传、输出、临时目录，可能含空格）连同其下的子目录整体去掉，其余绝对路径按正则去掉目录部分
 */
export function redactPaths(text: string, extraRoots: readonly string[] = []): string {
  let result = text;
  const roots = [config.uploadDir, config.outputDir, ...extraRoots]
    .filter(Boolean)
    .map((root) => path.resolve(root))
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    for (const variant of new Set([root, root.split(path.sep).join('/')])) {
      const pattern = new RegExp(`${escapeRegExp(variant)}(?:[\\\\/]${SEGMENT})*[\\\\/]`, 'g');
      result = result.replace(pattern, '');
    }
  }
  return result.replace(ABSOLUTE_DIR, '');
}
