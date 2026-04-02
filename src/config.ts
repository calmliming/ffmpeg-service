import path from 'path';

export const config = {
  port: Number(process.env.PORT) || 9527,
  uploadDir: path.resolve(__dirname, '../uploads'),
  outputDir: path.resolve(__dirname, '../output'),
  maxFileSize: 500 * 1024 * 1024, // 500MB
};
