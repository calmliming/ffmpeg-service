FROM node:20-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false

COPY . .
RUN pnpm build

ENV FFMPEG_PATH=ffmpeg
ENV FFPROBE_PATH=ffprobe
ENV PORT=9527

EXPOSE 9527

CMD ["node", "dist/index.js"]
