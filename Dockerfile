# --- 第一阶段：构建环境 ---
FROM node:20-slim AS builder

WORKDIR /app

# 复制依赖定义和同步脚本
COPY package*.json ./
COPY scripts/sync-env.js ./scripts/

# 1. 安装依赖
RUN npm ci && npm cache clean --force

# 2. 如果设置了 INFISICAL_TOKEN，在构建阶段同步环境变量
# 这样测试就能使用从 Infisical 获取的变量
ARG INFISICAL_TOKEN
ARG INFISICAL_PROJECT_ID
ARG INFISICAL_ENV=prod
ARG INFISICAL_SECRET_PATH=/

ENV INFISICAL_TOKEN=${INFISICAL_TOKEN}
ENV INFISICAL_PROJECT_ID=${INFISICAL_PROJECT_ID}
ENV INFISICAL_ENV=${INFISICAL_ENV}
ENV INFISICAL_SECRET_PATH=${INFISICAL_SECRET_PATH}

# 复制源代码
COPY . .

# 如果有 INFISICAL_TOKEN，先同步环境变量再运行测试
RUN if [ -n "$INFISICAL_TOKEN" ]; then \
    echo "🔄 在构建阶段同步 Infisical 环境变量..." && \
    node scripts/sync-env.js && \
    echo "✅ 环境变量同步完成"; \
    else \
    echo "⚠️ 跳过 Infisical 同步 (未设置 INFISICAL_TOKEN)"; \
    fi

# 运行测试
RUN npm test

# --- 第二阶段：运行环境 ---
FROM node:20-slim

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

# 4. 设置环境变量同步所需的默认值（可在运行时覆盖）
ENV INFISICAL_TOKEN=""
ENV INFISICAL_PROJECT_ID=""
ENV INFISICAL_ENV="prod"
ENV INFISICAL_SECRET_PATH="/"

# 5. 在容器启动时自动同步环境变量
# 如果设置了 INFISICAL_TOKEN，则同步；否则跳过
CMD sh -c 'if [ -n "$INFISICAL_TOKEN" ]; then echo "🔄 同步环境变量..."; node scripts/sync-env.js; else echo "⚠️ 跳过环境变量同步 (未设置 INFISISCAL_TOKEN)"; fi && node index.js'

EXPOSE 7860