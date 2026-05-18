# --- 第一阶段：生产依赖构建 ---
FROM node:20-slim AS prod-deps

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# --- 第二阶段：运行环境 ---
FROM node:20-slim

# 运行时参数：支持多环境部署
ARG NODE_ENV=production
ARG TARGETARCH
ARG APP_VERSION=unknown
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG IMAGE_TAG=unknown
ARG RELEASE_ID=unknown

# 环境变量
ENV NODE_ENV=${NODE_ENV}
ENV APP_VERSION=${APP_VERSION}
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV IMAGE_TAG=${IMAGE_TAG}
ENV RELEASE_ID=${RELEASE_ID}

LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.ref.name="${IMAGE_TAG}"

# 安装 rclone 和基础运行工具，包括 ping 工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    ca-certificates \
    iputils-ping \
    xz-utils \
    && curl -fsSL https://rclone.org/install.sh | bash \
    && runtime_arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "${runtime_arch}" in \
        amd64) cloudflared_arch="amd64" ;; \
        arm64) cloudflared_arch="arm64" ;; \
        *) echo "Unsupported cloudflared architecture: ${runtime_arch}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --output cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cloudflared_arch}.deb" \
    && dpkg -i cloudflared.deb \
    && rm cloudflared.deb \
    && apt-get purge -y --auto-remove unzip \
    && rm -rf /var/lib/apt/lists/* /tmp/*

# Install s6-overlay
ARG S6_OVERLAY_VERSION=3.1.6.2
RUN runtime_arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "${runtime_arch}" in \
        amd64) s6_arch="x86_64" ;; \
        arm64) s6_arch="aarch64" ;; \
        *) echo "Unsupported s6-overlay architecture: ${runtime_arch}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --output /tmp/s6-overlay-noarch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    && curl -fsSL --output /tmp/s6-overlay-arch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${s6_arch}.tar.xz" \
    && tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz \
    && rm /tmp/s6-overlay-noarch.tar.xz /tmp/s6-overlay-arch.tar.xz

WORKDIR /app

COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

COPY etc/ /etc/
RUN find /etc/s6-overlay/s6-rc.d -name "run" -exec chmod +x {} +
RUN find /etc/s6-overlay/s6-rc.d -name "finish" -exec chmod +x {} +

COPY . .

RUN mkdir -p /tmp/downloads && chown node:node /tmp/downloads && chmod 755 /tmp/downloads

RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
# 注意：原有的 /app/entrypoint.sh 将不再是容器的直接入口点。
# 如果 /app/entrypoint.sh 负责启动 Node.js 应用，
# 你需要将其定义为一个 s6-overlay 服务，例如在 etc/s6-overlay/s6-rc.d/app/run 中执行它。
CMD []

EXPOSE 7860
