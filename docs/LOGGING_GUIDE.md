# 日志规范指南 (Logging Guidelines)

本指南定义了 `drive-collector-js` 项目中的日志记录标准。我们的目标是实现 **“结构化数据、语义化文案、可视化反馈”** 的平衡。

## 1. 核心架构

项目采用统一的 `LoggerService` 分发日志。

- **控制台 (Console)**：面向开发者，提供直观的、带 Emoji 的单行展示。
- **远程平台 (New Relic / Axiom)**：面向监控与分析，提供完整的结构化元数据（env, module, version, instanceId）。

## 2. 文案风格

采取 **“中英混排、动作中文、术语英文”** 的原则。

- **动作与状态使用中文**：方便快速扫描日志（如：启动、连接成功、认证失败）。
- **技术术语保留英文**：保留 Redis, Telegram, Session, OAuth, HTTP, API 等原生术语。
- **避免硬编码前缀**：严禁在 `message` 中使用 `[Module]` 这种硬编码的中括号前缀，模块信息应通过 `withModule` 或 `context` 自动注入。

### 示例对比
- ❌ `log.info("[HttpServer] Starting HTTP Server...")`
- ✅ `log.info("🚀 正在启动 HTTP 服务器...")`

## 3. 语义化 Emoji 引擎

系统会自动根据 `module` 和 `message` 内容追加 Emoji。

| 模块类别 | 图标 | 适用范围 |
| :--- | :--- | :--- |
| **Telegram** | `✈️` | TelegramClient, Dispatcher, TelegramService |
| **网络/HTTP** | `🌐` | HttpServer, Webhook, API 请求 |
| **缓存/Redis** | `💾` | Redis, Valkey, MemoryCache |
| **数据库** | `🗄️` | D1, SQLite, Repository |
| **队列/任务** | `📬` | Queue, Qstash, TaskManager |
| **存储/OSS** | `☁️` | R2, S3, OSS |
| **核心/配置** | `⚙️` | App, Config, Infisical |
| **隧道** | `🚇` | Cloudflare Tunnel |

### 动态状态增强
引擎会扫描 `message` 中的关键字并追加状态图标：
- **启动/成功**: `🚀`, `✅`
- **失败/停止**: `❌`, `🛑`
- **连接/链路**: `🔗`
- **安全/锁定**: `🔒`

## 4. 日志级别规范

- **`error` (🚨)**：不可恢复的错误、进程崩溃、核心配置缺失。必须传入 `error` 对象作为第二个参数。
- **`warn` (⚠️)**：预期内的异常、自动重试、非致命的配置错误、性能预警。
- **`info` (ℹ️)**：核心生命周期事件（启动/停止）、关键业务状态切换、成功连接。
- **`debug` (🔍)**：详细的调试信息、正则表达式匹配详情、数据包原始内容。生产环境默认开启智能过滤。

## 5. 结构化元数据 (Metadata)

始终优先使用结构化数据而非拼接长字符串。

```javascript
// ❌ 错误做法：将详细数据拼接到消息中
log.info(`User ${userId} logged in from ${ip}`);

// ✅ 正确做法：消息保持简洁，数据通过对象传递
log.info('👤 用户登录成功', { userId, ip });
```

## 6. 特殊场景处理

### 6.1 敏感信息屏蔽
严禁在日志中记录 `API_HASH`, `BOT_TOKEN`, `Session String` 或用户密码等敏感信息。

### 6.2 异常处理
在捕获到 `Unhandled Rejection` 时，日志必须包含原始错误信息，并注明发生的具体模块或流程。

---

🤖 *本规范由 Antigravity 自动生成并应用于 codebase。*
