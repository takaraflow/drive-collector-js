# --- 第一阶段：构建环境 ---
FROM node:20-slim AS builder

WORKDIR /app

# 复制依赖定义
COPY package*.json ./

# 1. 修改点：安装依赖后立即清理缓存，减少中间层体积
RUN npm ci && npm cache clean --force

# 复制源代码
COPY . .

# 运行测试
RUN npm test

# --- 第二阶段：运行环境 ---
FROM node:20-slim

# 安装 rclone 和基础工具
# 2. 修改点：安装完 curl/unzip 后立即卸载，只保留运行 rclone 所需的 ca-certificates
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ca-certificates \
    && curl https://rclone.org/install.sh | bash \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- 强制依赖第一阶段的测试结果 ---
COPY package*.json ./

RUN mkdir -p ./scripts
COPY scripts ./scripts/

# 安装生产依赖
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /tmp/downloads && chmod 777 /tmp/downloads
EXPOSE 7860
CMD ["node", "index.js"]