# --- 第一阶段：构建环境 ---
FROM node:20-slim AS builder

WORKDIR /app

# 复制依赖定义
COPY package*.json ./

# 安装依赖
RUN npm install --production

# --- 第二阶段：运行环境 ---
FROM node:20-slim

# 安装 rclone 和基础工具
RUN apt-get update && apt-get install -y \
    rclone \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 从构建阶段复制 node_modules
COPY --from=builder /app/node_modules ./node_modules
# 复制源代码
COPY . .

# 创建必要的目录并设置权限
RUN mkdir -p /tmp/downloads && chmod 777 /tmp/downloads

# 健康检查端口
EXPOSE 7860

# 使用 node 直接运行（生产环境建议使用此方式）
CMD ["node", "index.js"]