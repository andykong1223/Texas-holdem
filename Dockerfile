# 国内默认走 DaoCloud，避免直连 Docker Hub 超时。
# 海外可覆盖：
#   docker build --build-arg NODE_IMAGE=node:22-alpine .
ARG NODE_IMAGE=m.daocloud.io/docker.io/library/node:22-alpine

FROM ${NODE_IMAGE}

# Alpine 软件源改为阿里云（失败则忽略）
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories || true

WORKDIR /app

# npm 使用 npmmirror
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
