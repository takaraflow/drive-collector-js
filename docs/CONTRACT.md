# API 接口契约文档

## 概述

本文档定义了 lb-worker-js（Load Balancer）与 drive-collector-js 实例之间的接口交互规范。

### 架构

```
QStash (消息队列)
    ↓ 发布消息 (topics: download-tasks, upload-tasks, media-batch)
LB Worker (负载均衡)
    ↓ 转发请求（带 QStash v2 签名验证）
drive-collector-js 实例
    ↓ 处理任务
TaskManager / TaskRepository
```

### 服务职责

| 服务 | 职责 |
|------|------|
| **QStash** | 消息队列、任务调度、消息持久化、自动重试 |
| **LB Worker** | 负载均衡、签名验证、实例发现、故障转移 |
| **drive-collector-js** | 任务处理、文件传输、状态管理 |

---

## 通用规范

### 认证方式

所有 Webhook 请求都需要 **QStash v2 签名验证**。

#### 签名头

| Header | 说明 | 示例 |
|--------|------|------|
| `Upstash-Signature` | QStash v2 签名值 | `v2,abc123def456...` |
| `Upstash-Timestamp` | 请求时间戳（可选，用于过期检查） | `1704700800` |

#### 验证方式

- **SDK**: 使用 `@upstash/qstash` 的 `Receiver.verify()`
- **代码示例**:
```javascript
import { Receiver } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY || env.QSTASH_CURRENT_SIGNING_KEY
});

const isValid = await receiver.verify({
  signature: request.headers.get('Upstash-Signature'),
  body: requestBody,
  url: request.url,
  clockTolerance: 300  // 5分钟时钟偏差容忍度
});
```

#### 过期窗口

- **默认**: 900秒（15分钟）
- **配置**: `SIGNATURE_EXPIRATION_WINDOW` 环境变量
- **测试环境**: 设置 `SKIP_SIGNATURE_VERIFY=true` 跳过验证

### 通用请求头

| Header | 说明 | 示例 |
|--------|------|------|
| `Upstash-Signature` | QStash v2 签名 | `v2,abc123...` |
| `Upstash-Timestamp` | 请求时间戳（可选） | `1704700800` |
| `Upstash-Message-Id` | QStash 消息ID | `msg_abc123` |
| `Upstash-Retries` | 重试次数 | `2` |
| `Content-Type` | 内容类型 | `application/json` |
| `Host` | 目标主机 | 由 LB 转发时替换 |
| `X-Load-Balancer` | 负载均衡器标识 | `qstash-lb` |
| `X-Forwarded-Host` | 原始Host头 | `lb.example.com` |
| `X-Forwarded-Proto` | 原始协议 | `https` |
| `X-Forwarded-For` | 客户端IP | `1.2.3.4` |

### 通用响应格式

#### 成功响应

- **HTTP 状态**: `200`
- **Content-Type**: `text/plain`
- **Body**: `OK`

#### 错误响应

- **HTTP 状态**: `401`, `500`, `503`
- **Content-Type**: `application/json`
- **Body**:
```json
{
  "error": "错误类型",
  "message": "详细错误信息",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

---

## 端点定义

### 1. 健康检查

#### LB Worker (`/health`)

- **路径**: `/health`
- **方法**: `GET`, `HEAD`
- **描述**: 返回 LB 运行状态、活跃实例数量和 provider 信息

**请求示例**:
```http
GET /health
Host: lb-worker-js.example.com
```

**响应示例** (200):
```json
{
  "status": "ok",
  "activeInstances": 3,
  "provider": "cloudflare",
  "timestamp": "2026-01-08T12:00:00.000Z",
  "uptime": 1704700800
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| status | string | 状态，固定为 `ok` |
| activeInstances | integer | 当前活跃实例数量 |
| provider | string | 当前使用的缓存提供者（cloudflare/upstash/redis） |
| timestamp | string | ISO 8601 格式的时间戳 |
| uptime | integer | 服务启动时间（Unix 时间戳秒） |

#### drive-collector-js (`/health`)

- **路径**: `/health`
- **方法**: `GET`, `HEAD`
- **描述**: 简单的健康检查

**请求示例**:
```http
GET /health
Host: drive-collector-js.example.com
```

**响应示例** (200):
```
OK
```

---

### 2. 下载任务 Webhook

- **路径**: `/api/tasks/download`
- **方法**: `POST`
- **认证**: QStash v2 签名
- **描述**: 处理下载任务

#### 调用流程

```
1. drive-collector-js 发布任务到 QStash
   Topic: download
   URL: ${LB_WEBHOOK_URL}/api/tasks/download

2. QStash 持久化消息并触发 Webhook
   Headers: Upstash-Signature, Upstash-Timestamp

3. LB Worker 接收并验证签名
   verifyQStashSignature(request, env, false)

4. LB Worker 查询活跃实例
   getActiveInstances() - 扫描 Redis/KV 中的 instance:*

5. LB Worker 通过轮询选择一个实例
   selectTargetInstance() - 基于 lb:round_robin_index

6. LB Worker 转发请求到实例
   forwardToInstance() - 保留签名和元数据

7. drive-collector-js 实例处理任务
   TaskManager.handleDownloadWebhook(taskId)
```

#### 请求体

```json
{
  "taskId": "task_123",
  "type": "download",
  "_meta": {
    "triggerSource": "direct-qstash",
    "instanceId": "instance-1",
    "timestamp": 1704700800000,
    "caller": "QStashService.publish"
  }
}
```

#### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| taskId | string | 是 | 任务ID |
| type | string | 否 | 任务类型，默认为 `download` |
| _meta | object | 否 | 元数据（由QStash或LB添加） |

#### _meta 字段说明

| 字段 | 类型 | 说明 | 添加方 |
|------|------|------|--------|
| triggerSource | string | 触发来源（direct-qstash/unknown） | QStashService |
| instanceId | string | 发布任务的实例ID | QStashService |
| timestamp | integer | 发布时间戳（毫秒） | QStashService |
| caller | string | 调用者信息（堆栈跟踪） | QStashService |

#### 响应

- **成功**: `200 OK`
- **失败**: `401 Unauthorized`, `500 Internal Server Error`

---

### 3. 上传任务 Webhook

- **路径**: `/api/tasks/upload`
- **方法**: `POST`
- **认证**: QStash v2 签名
- **描述**: 处理上传任务

#### 请求体

```json
{
  "taskId": "task_456",
  "type": "upload",
  "_meta": {
    "triggerSource": "direct-qstash",
    "instanceId": "instance-2",
    "timestamp": 1704700800000
  }
}
```

#### 处理流程

1. LB Worker 接收请求
2. 验证 QStash 签名
3. 转发到 drive-collector-js 实例
4. 实例调用 `TaskManager.handleUploadWebhook(taskId)`

---

### 4. 媒体批次 Webhook

- **路径**: `/api/tasks/batch`
- **方法**: `POST`
- **认证**: QStash v2 签名
- **描述**: 处理批量媒体文件的下载任务

#### 请求体

```json
{
  "groupId": "media_group_123",
  "taskIds": ["task_1", "task_2", "task_3"],
  "_meta": {
    "triggerSource": "direct-qstash",
    "instanceId": "instance-1"
  }
}
```

#### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| groupId | string | 是 | 媒体组ID |
| taskIds | array[string] | 是 | 任务ID列表 |
| _meta | object | 否 | 元数据 |

#### 处理流程

1. LB Worker 接收请求
2. 验证 QStash 签名
3. 转发到 drive-collector-js 实例
4. 实例调用 `TaskManager.handleMediaBatchWebhook(groupId, taskIds)`

---

### 5. 系统事件 Webhook

- **路径**: `/api/tasks/system-events`
- **方法**: `POST`
- **认证**: QStash v2 签名
- **描述**: 系统级事件（当前仅记录，不处理）

#### 请求体

```json
{
  "event": "test-event",
  "data": {
    "key": "value"
  }
}
```

#### 处理流程

1. LB Worker 接收请求
2. 验证 QStash 签名
3. 转发到 drive-collector-js 实例
4. 实例记录事件日志（不执行任何操作）

---

## 错误处理

### 错误码

| 状态码 | 说明 | 产生方 | 处理策略 |
|--------|------|--------|----------|
| 200 | 成功 | 双方 | 返回成功结果 |
| 401 | 签名验证失败 | LB Worker | 停止重试 |
| 404 | 路径不存在 | LB Worker | 返回 404 |
| 500 | 内部错误 | 双方 | 记录日志，继续重试 |
| 503 | 无可用实例 | LB Worker | 返回 503，QStash 自动重试 |

### 401 签名验证失败

**LB Worker 响应**:
```json
{
  "error": "Signature verification failed",
  "message": "Invalid signature",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

**处理策略**: 停止重试（QStash 不会重试 4xx 错误）

### 503 无可用实例

**LB Worker 响应**:
```json
{
  "error": "No active instances available",
  "qstashMsgId": "msg_abc123",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

**请求头**:
```
Retry-After: 60
```

**处理策略**:
- LB Worker 返回 503 和 `Retry-After: 60` 头
- QStash 根据重试策略自动重试

### 500 内部错误

**LB Worker 响应**:
```json
{
  "error": "Internal Server Error",
  "message": "详细错误信息",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

**处理策略**:
- 记录错误日志（Axiom）
- QStash 自动重试（最多 3 次）

---

## 负载均衡策略

### 实例发现

LB Worker 从存储后端发现活跃实例：

```
存储后端: Redis / Cloudflare KV / Upstash Redis
键前缀: instance:
键格式: instance:{instanceId}
值格式:
{
  "id": "instance-1",
  "url": "https://drive-collector-js-1.example.com",
  "hostname": "node-1",
  "region": "us-east-1",
  "status": "active",
  "lastHeartbeat": 1704700800000,
  "startedAt": 1704700000000
}
```

### 心跳检测

- **心跳间隔**: 300秒（5分钟）
- **超时阈值**: 900秒（15分钟）
- **检测机制**: 扫描所有 `instance:*` 键，检查 `lastHeartbeat`

### 轮询选择

- **键**: `lb:round_robin_index`
- **机制**: 原子递增
- **分配**: `index % instances.length`

### 故障转移

**提供者优先级**:
1. NF Redis (`NF_REDIS_URL`)
2. Cloudflare KV (`KV_STORAGE`)
3. Upstash Redis (`UPSTASH_REDIS_REST_URL`)

**故障转移条件**:
- 配额错误（free usage limit, quota exceeded）
- 网络错误（fetch failed, network error）
- 连续失败 3 次

**故障转移策略**:
- 立即切换到下一个可用的 provider
- 记录故障转移日志
- 支持自动恢复

---

## 版本兼容性

### 向后兼容

LB Worker 提供路径规范化层，支持以下别名：

| 原始路径 | 规范化后 | 说明 |
|---------|---------|------|
| `/api/tasks/download-tasks` | `/api/tasks/download` | 旧的长路径（向后兼容） |
| `/api/tasks/upload-tasks` | `/api/tasks/upload` | 旧的长路径（向后兼容） |
| `/api/tasks/media-batch` | `/api/tasks/batch` | 旧的媒体批次路径（向后兼容） |
| `/api/tasks/download` | `/api/tasks/download` | 当前使用的短路径 |
| `/api/tasks/upload` | `/api/tasks/upload` | 当前使用的短路径 |
| `/api/tasks/batch` | `/api/tasks/batch` | 当前使用的批次路径 |

**注意**: 当前 QStash 和 drive-collector-js 都使用短路径，长路径仅用于向后兼容。

### 配置迁移

#### 旧版配置（v0.15.0 之前）

```javascript
const PATH_MAP = {
  '/api/tasks/download': '/api/tasks/download-tasks',
  '/api/tasks/upload': '/api/tasks/upload-tasks'
};
```

#### 新版配置（v0.15.0+）

```javascript
const PATH_MAP = {
  '/api/tasks/download-tasks': '/api/tasks/download',
  '/api/tasks/upload-tasks': '/api/tasks/upload',
  '/api/tasks/media-batch': '/api/tasks/batch'
};
```

**变更说明**:
- v0.15.0 之前：映射方向为短→长
- v0.15.0+：映射方向为长→短（向后兼容旧的长路径）

---

## 配置

### LB Worker 环境变量

| 变量 | 说明 | 必需 | 默认值 |
|------|------|------|--------|
| `QSTASH_CURRENT_SIGNING_KEY` | 当前签名密钥 | 是 | - |
| `QSTASH_NEXT_SIGNING_KEY` | 下一个签名密钥 | 否 | 使用 current |
| `SIGNATURE_EXPIRATION_WINDOW` | 签名过期窗口（秒） | 否 | 900 |
| `SKIP_SIGNATURE_VERIFY` | 跳过签名验证（测试用） | 否 | false |
| `NF_REDIS_URL` | Northflank Redis URL | 否* | - |
| `NF_REDIS_PASSWORD` | Northflank Redis 密码 | 否* | - |
| `KV_STORAGE` | Cloudflare KV 命名空间 | 否* | - |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL | 否* | - |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token | 否* | - |

* 至少需要配置一个缓存提供者

### drive-collector-js 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `QSTASH_TOKEN` | QStash API Token | 是* |
| `QSTASH_URL` | QStash API URL | 否 |
| `QSTASH_CURRENT_SIGNING_KEY` | 当前签名密钥 | 是* |
| `QSTASH_NEXT_SIGNING_KEY` | 下一个签名密钥 | 否 |
| `LB_WEBHOOK_URL` | LB Worker URL | 是* |
| `INSTANCE_ID` | 当前实例ID | 是* |
| `INSTANCE_COUNT` | 总实例数量 | 是* |
| `PORT` | Webhook 端口 | 否，默认 7860 |

#### 队列幂等性配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QUEUE_USE_IDEMPOTENCY` | `false` | 启用 Redis 原子分布式去重；任务队列同时使用 QStash deduplicationId |
| `QUEUE_IDEMPOTENCY_TTL` | `86400` | Redis key TTL（秒），默认 24 小时 |
| `QUEUE_LOCAL_IDEMPOTENCY_LIMIT` | `1000` | 本地缓存最大条目数 |

* 启用 QStash 功能时需要

### Manifest 端点配置

两个项目的 `manifest.json` 应该包含以下端点定义：

```json
{
  "endpoints": {
    "health": "/health",
    "webhookBase": "/api/tasks",
    "download": "/api/tasks/download",
    "upload": "/api/tasks/upload",
    "batch": "/api/tasks/batch",
    "systemEvents": "/api/tasks/system-events"
  }
}
```

---

## 测试和调试

### 本地测试

#### 1. 测试健康检查

```bash
# LB Worker
curl https://lb-worker-js.example.com/health

# drive-collector-js
curl https://drive-collector-js.example.com/health
```

#### 2. 测试 Webhook 签名验证

使用 `@upstash/qstash` 发送测试消息：

```javascript
import { Client } from '@upstash/qstash';

const client = new Client({ token: process.env.QSTASH_TOKEN });

await client.publishJSON({
  url: 'https://lb-worker-js.example.com/api/tasks/download-tasks',
  body: { taskId: 'test_123' }
});
```

#### 3. 跳过签名验证（测试环境）

```bash
export SKIP_SIGNATURE_VERIFY=true
npm run dev
```

### 调试日志

#### LB Worker 日志

```javascript
// 查看日志（Axiom）
curl -X GET "https://api.axiom.co/v1/datasets/<dataset>/query?apiKey=<token>"
```

关键日志：
- `LB Request Started` - 请求开始
- `活跃实例查询完成` - 实例发现
- `负载均衡请求完成` - 请求转发完成
- `签名验证失败` - 签名错误
- `无活跃实例可用` - 503 错误

#### drive-collector-js 日志

关键日志：
- `📥 收到 Webhook: {path}` - 接收请求
- `QStash 签名验证失败` - 签名错误
- `TaskManager.handleDownloadWebhook` - 任务处理

---

## 变更日志

### v1.1.0 (2026-01-08)

- 统一使用短路径（简洁版）
- 更新端点为 `/api/tasks/download`, `/api/tasks/upload`, `/api/tasks/batch`
- 添加长路径到短路径的向后兼容映射
- 统一 manifest.json 端点键名为短名称（download, upload, batch）

### v1.0.0 (2026-01-08)

- 初始版本
- 定义基础端点和认证方式
- 添加 QStash v2 签名规范
- 添加负载均衡策略
- 添加故障转移机制

---

## 附录

### A. QStash Topic 列表

| Topic | 端点 | 处理函数 |
|-------|------|---------|
| `download` | `/api/v2/tasks/download` | `TaskManager.handleDownloadWebhook()` |
| `upload` | `/api/v2/tasks/upload` | `TaskManager.handleUploadWebhook()` |
| `system-events` | `/api/v2/tasks/system-events` | `MediaGroupBuffer.handleFlushEvent()` |
| `state_sync` | `/api/v2/tasks/state_sync` | `StateSynchronizer.handleSyncEvent()` |
| `cache_sync` | `/api/v2/tasks/cache_sync` | `ConsistentCache.handleSyncEvent()` |

**注意**: `batch` 不是独立 topic，而是通过 `download` topic 的 batch publish 触发。

### B. 实例注册格式

```javascript
{
  id: "instance-1",
  url: "https://drive-collector-js-1.example.com",
  hostname: "node-1",
  region: "us-east-1",
  status: "active",
  lastHeartbeat: 1704700800000,
  startedAt: 1704700000000
}
```

### C. 分布式锁键格式

```
lock:{lockKey}
task:{taskId}
msg_lock:{msgId}
lb:round_robin_index
lb:leader
```

### D. 相关文档

- [lb-worker-js README](../README.md)
- [drive-collector-js README](../drive-collector-js/README.md)
- [队列幂等性指南](./QUEUE_IDEMPOTENCY_GUIDE.md)
- [QStash 文档](https://upstash.com/docs/qstash)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)

---

**最后更新**: 2026-02-27
**维护者**: shangxin <shangxin@outlook.com>
