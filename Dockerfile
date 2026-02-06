# --- 第一阶段：构建环境 ---
FROM node:20-slim AS builder

WORKDIR /app

# 构建参数：支持多环境构建
ARG NODE_ENV=production

# 环境变量
ENV NODE_ENV=${NODE_ENV}

# 复制依赖定义
COPY package*.json ./

# 1. 安装依赖
RUN npm ci && npm cache clean --force

# 复制源代码
COPY . .

# 运行测试
RUN npm test

# --- 第二阶段：运行环境 ---
FROM node:20-slim

# 运行时参数：支持多环境部署
ARG NODE_ENV=production

# 环境变量
ENV NODE_ENV=${NODE_ENV}

# 安装 rclone 和基础工具，包括 ping 工具
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ca-certificates \
    iputils-ping \
    xz-utils \
    && curl https://rclone.org/install.sh | bash \
    && curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    && dpkg -i cloudflared.deb \
    && rm cloudflared.deb \
    && apt-get purge -y unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install s6-overlay
ARG S6_OVERLAY_VERSION=3.1.6.2
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz

WORKDIR /app

# --- 强制依赖第一阶段的测试结果 ---
COPY package*.json ./

RUN mkdir -p ./scripts
COPY scripts ./scripts/

# 安装生产依赖
RUN npm ci --omit=dev && npm cache clean --force
COPY etc/ /etc/
RUN find /etc/s6-overlay/s6-rc.d -name "run" -exec chmod +x {} +
RUN find /etc/s6-overlay/s6-rc.d -name "finish" -exec chmod +x {} +

COPY . .

RUN mkdir -p /tmp/downloads && chmod 777 /tmp/downloads

RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/init"]
# 注意：原有的 /app/entrypoint.sh 将不再是容器的直接入口点。
# 如果 /app/entrypoint.sh 负责启动 Node.js 应用，
# 你需要将其定义为一个 s6-overlay 服务，例如在 etc/s6-overlay/s6-rc.d/app/run 中执行它。
CMD []

EXPOSE 7860
