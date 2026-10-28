# FFmpeg 9.0.2：Alpine 3.24 只有 8.1.3，edge 也没有 9.x，Debian trixie 的 apt 版本是 7.1.5，所以用静态构建。
# 按多架构 digest 钉住。静态二进制不在系统包管理器里，Trivy 等扫描器看不到它，升级要人工跟踪 ffmpeg.org/security。
FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

# 用 glibc 的 slim 镜像：Node 在 musl（alpine）上不是一级支持平台；公司标准同样要求 slim。
# 版本与 .nvmrc 保持一致，升级时三处（这里、下面的 build 阶段、.nvmrc）一起改。
# runtime 阶段只有 Node + FFmpeg + 字体，可以单独构建来验证字体：docker build --target runtime .
FROM node:24.22.1-trixie-slim AS runtime

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

# slim 镜像里一个字体都没有，drawtext 文字水印和 subtitles 烧录字幕会直接失败或把中文画成方框。
# fonts-noto-cjk 是思源黑体 / 宋体（Noto Sans/Serif CJK），fonts-dejavu-core 补拉丁字母，
# fontconfig 提供 /etc/fonts 配置和字体缓存，静态 FFmpeg 里的 fontconfig 和 libass 都靠它按名字找字体。
# deb.debian.org 在国内很慢，可以传 APT_MIRROR=http://mirrors.aliyun.com 之类的镜像源。
# 镜像里没有 CA 证书，只能用 http 源；APT 会用 Debian 的签名校验软件包，不怕中间人篡改。
# 宋体（Noto Serif CJK）占 54 MB 而且用不到，用 dpkg 的 path-exclude 不解包（slim 镜像排除文档用的也是这个机制）
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR%/}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && echo 'path-exclude=/usr/share/fonts/opentype/noto/NotoSerifCJK*' > /etc/dpkg/dpkg.cfg.d/no-serif-cjk \
    && apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
    && fc-cache -f

# Noto CJK 的 .ttc 里第 0 个字体是日文（JP），drawtext 用 fontfile 时只能取第 0 个，简体字会用日文字形。
# 所以只设字体名，让 fontconfig 选中简体中文（SC）那一个；libass 烧录字幕同样按名字找
ENV FONT_NAME="Noto Sans CJK SC"

# 构建阶段：装全部依赖、编译 TypeScript，再删掉开发依赖。最终镜像里没有 TypeScript、ESLint、源码和测试
FROM node:24.22.1-trixie-slim AS build

WORKDIR /app

# 国内服务器直连 registry.npmjs.org 经常 ECONNRESET，构建时传 NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Node 24 自带 corepack（24.22.1 带的是 0.36.0），由它按 packageManager 拉取 pnpm 12。
# 以后升到 Node 25 及以上时镜像里没有 corepack，要先 npm install -g corepack
RUN corepack enable \
    && pnpm config set registry "$NPM_REGISTRY" \
    && pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM runtime

WORKDIR /app

# dist/index.js 运行时读 ../package.json 取版本号
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# .env 不打进镜像（见 .dockerignore），docker compose 通过 env_file 在运行时注入。
# 这三项写在 docker-compose.yml 的 environment 里固定住，.env 里的同名变量不生效
ENV FFMPEG_PATH=ffmpeg
ENV FFPROBE_PATH=ffprobe
ENV PORT=9527

# 用 node 镜像自带的 node 用户（uid 1000）运行：服务要解码不受信任的上传文件和 URL，
# FFmpeg 解码器出漏洞时拿到的只是普通用户。代码、依赖和字体仍归 root，node 只能读；
# 只有上传目录和产物目录归 node。目录在镜像里先建好：docker 新建命名卷挂到这里时会复制目录的属主，卷才可写。
# 从以 root 运行的旧版本升级时，已有卷里的文件属于 root，要先改一次属主（见部署指南）
RUN mkdir -p /app/uploads /app/output && chown node:node /app/uploads /app/output
USER node

EXPOSE 9527

CMD ["node", "dist/index.js"]
