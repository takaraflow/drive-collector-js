# Drive Collector Bot

一个模块化的 Telegram 机器人，用于将文件传输到 Rclone 远程存储。

## 功能特性

- 通过 Rclone 将文件从 Telegram 传输到云存储
- 批量文件处理与进度监控
- 队列管理以实现并发上传
- 模块化架构，包含仓库、服务和 UI 模板

## 安装

```bash
npm install
```

## 配置

1.  复制 `.env.example` 文件到 `.env`：

    ```bash
    cp .env.example .env
    ```

2.  编辑 `.env` 文件并填入您的凭据。所有必需的环境变量都已在此文件中列出。

## QStash 集成

QStash 被集成作为消息队列系统，以实现可靠的异步任务处理和 webhook 处理。

### 目的和架构

- **解耦**: 将任务调度与执行分离，实现弹性扩展
- **可靠性**: 消息持久化并在失败时重试
- **Webhook 安全**: 使用加密签名验证传入的 webhook
- **主题**: 组织为 `download-tasks`、`upload-tasks` 和 `system-events`

### 架构概览

```
Telegram 机器人 → QStash → Webhook → Cloudflare Worker LB → 活跃实例
     ↓              ↓              ↓              ↓              ↓
   任务创建        消息队列       签名          负载均衡        任务处理
   (同步)         (异步)         验证          (轮询)          (异步)
```

### 功能特性

- **消息发布**: 将任务发送到不同主题，支持可选延迟
- **批量操作**: 高效处理多个相关任务
- **签名验证**: 确保 webhook 真实性
- **媒体组批处理**: 聚合相关媒体文件进行批处理

## Cloudflare Worker 负载均衡器

一个 Cloudflare Worker，用于将 QStash webhook 分发到多个机器人实例以实现高可用性。

### 作用和功能

- **负载分发**: 使用轮询算法将传入的 webhook 路由到活跃实例
- **健康监控**: 通过心跳机制跟踪实例状态
- **容错能力**: Cloudflare KV 和 Upstash Redis 之间的自动故障转移
- **签名验证**: 在转发前验证 QStash webhook 签名

### 通过 GitHub Actions 部署

负载均衡器在推送更改到影响 worker 文件的 `main` 或 `develop` 分支时自动部署。

**工作流触发器：**
- 推送至 `main` → 生产环境
- 推送至 `develop` → 开发环境

**环境特定配置：**
- 生产: `qstash-lb` worker 与生产 KV 命名空间
- 开发: `qstash-lb-dev` worker 与暂存 KV 命名空间

## 使用方法

```bash
npm start
```

开发模式下带自动重启：

```bash
npm run dev
```

## 测试

运行测试套件：

```bash
npm test
```

测试覆盖：
- UI 模板渲染（进度条、批量监控器）
- 基本功能验证

### CI/CD

测试会在以下情况下自动运行：
- 推送至 `main` 或 `develop` 分支
- 拉取请求至 `main` 或 `develop` 分支

使用 Node.js 20.x 的 GitHub Actions。

## 架构

- `src/core/`: 核心业务逻辑（TaskManager）
- `src/services/`: 外部集成（Telegram、Rclone）
- `src/repositories/`: 数据持久化层
- `src/ui/`: 用户界面模板
- `src/utils/`: 工具函数
- `src/bot/`: 机器人事件处理（Dispatcher）
- `src/modules/`: 附加模块（AuthGuard 等）

## 环境变量和 GitHub Secrets 配置

### 环境变量（运行时）

| 变量 | 描述 | 必需 |
|------|------|------|
| `BOT_TOKEN` | Telegram 机器人令牌 | 是 |
| `API_ID` | Telegram API ID | 是 |
| `API_HASH` | Telegram API Hash | 是 |
| `OWNER_ID` | 机器人所有者 Telegram ID | 是 |
| `PORT` | 服务器端口（默认：7860） | 否 |
| `QSTASH_TOKEN` | Upstash QStash API 令牌 | 否* |
| `QSTASH_URL` | QStash 端点 URL | 否* |
| `QSTASH_CURRENT_SIGNING_KEY` | 当前 webhook 签名密钥 | 否* |
| `QSTASH_NEXT_SIGNING_KEY` | 下一个 webhook 签名密钥 | 否* |
| `LB_WEBHOOK_URL` | Webhook 基本 URL | 否* |
| `INSTANCE_COUNT` | 分片的实例总数 | 否 |
| `INSTANCE_ID` | 当前实例 ID（1-N） | 否 |

*QStash 功能必需

### GitHub Secrets（部署）

| Secret | 生产 | 开发 | 描述 |
|--------|------|------|------|
| `CLOUDFLARE_API_TOKEN` | 必需 | 必需 | 部署的 Cloudflare API 令牌 |
| `CLOUDFLARE_ACCOUNT_ID` | 必需 | 必需 | Cloudflare 账户 ID |
| `WORKER_NAME` | `qstash-lb` | `qstash-lb-dev` | Worker 名称 |
| `CF_KV_NAMESPACE_ID` | 生产 NS | 暂存 NS | KV 命名空间 ID |
| `QSTASH_CURRENT_SIGNING_KEY` | 生产密钥 | 开发密钥 | Webhook 签名密钥 |
| `UPSTASH_REDIS_REST_URL` | 生产 URL | 开发 URL | Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | 生产令牌 | 开发令牌 | Redis REST 令牌 |

### Secrets 设置指南

1. **Cloudflare 设置：**
   - 创建具有 Workers 和 KV 权限的 API 令牌
   - 从 Cloudflare 仪表板获取您的账户 ID

2. **KV 命名空间：**
   - 生产: 创建 `PRODUCTION_NS` 命名空间
   - 开发: 创建 `STAGING_NS` 命名空间

3. **QStash 设置：**
   - 从 Upstash 控制台获取令牌
   - 为 webhook 验证生成签名密钥

4. **Upstash Redis（可选）：**
   - 为 KV 故障转移创建 Redis 数据库
   - 获取 REST URL 和令牌

## 本地开发和部署

### 本地开发

1. **安装依赖：**
   ```bash
   npm install
   ```

2. **环境设置：**
   ```bash
   cp .env.example .env  # 配置您的环境变量
   ```

3. **运行开发服务器：**
   ```bash
   npm run dev
   ```

4. **运行测试：**
   ```bash
   npm test
   ```

### 部署命令

#### 机器人部署
- **Docker 构建：** `docker build -t drive-collector-bot .`
- **Docker 运行：** `docker run -p 7860:7860 drive-collector-bot`
- **Railway：** 推送至 main/develop 时自动部署
- **Zeabur：** 通过 webhook 自动部署

#### 负载均衡器部署
- **自动：** 通过 GitHub Actions 在推送至 main/develop 时
- **手动构建：** `npm run build-lb`（生成 wrangler.build.toml）
- **手动部署：** 使用 Wrangler CLI 或 GitHub Actions

### 多环境设置

项目使用 GitHub Environments 实现隔离的生产和开发部署：

- **生产环境：** `main` 分支 → `qstash-lb` worker
- **开发环境：** `develop` 分支 → `qstash-lb-dev` worker

每个环境具有独立的：
- KV 命名空间（PRODUCTION_NS、STAGING_NS）
- QStash 签名密钥
- Upstash Redis 实例
- Worker 名称

### 零停机部署

对于多实例部署：

1. 设置 `INSTANCE_COUNT` 和 `INSTANCE_ID` 环境变量
2. 使用消息分片防止重复处理
3. 增量部署实例
4. 使用健康检查实现优雅关闭

## 许可证

ISC