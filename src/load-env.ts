import dotenv from 'dotenv';

// 必须是 src/index.ts 的第一个 import。tsx（esbuild）会把所有 import 提升到普通语句之前，
// 写在 index.ts 正文里的 dotenv.config() 会晚于 ./config 和 BullMQ worker 执行，pnpm dev 下 .env 因此从未生效。
// override 显式写 false：服务器上一旦设置了 DOTENV_OVERRIDE 或 DOTENV_CONFIG_OVERRIDE，
// dotenv 18 会让文件覆盖 docker compose 注入的环境变量。
dotenv.config({ path: '.env.local', override: false }); // 本地开发
dotenv.config({ override: false }); // 生产环境读 .env
