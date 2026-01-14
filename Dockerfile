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
# 3. 修改点：安装完 curl/unzip 后立即卸载，只保留运行 rclone 所需的 ca-certificates 和 ping 工具
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ca-certificates \
    iputils-ping \
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

CMD ["node", "index.js"]

EXPOSE 7860
