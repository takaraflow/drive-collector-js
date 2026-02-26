# 队列幂等性指南

## 概述

本文档介绍消息队列的幂等性保障机制，用于防止重复消息处理。

## 架构

### 两层幂等性检查

```
发布消息
    │
    ▼
┌─────────────────────┐
│  1. 本地缓存检查     │  ← 快速路径 (Set)
│  processedMessages  │
└─────────────────────┘
    │ 未命中
    ▼
┌─────────────────────┐
│  2. Redis 分布式检查 │  ← 可选 (需启用)
│  queue:idempotency: │
└─────────────────────┘
    │ 未命中
    ▼
  发布消息
```

### 类继承关系

```
BaseQueue
    │
    ▼
CloudQueueBase (通用幂等性逻辑)
    │
    ▼
QstashQueue (QStash 特有实现)
```

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QUEUE_USE_IDEMPOTENCY` | `false` | 启用 Redis 分布式去重 |
| `QUEUE_IDEMPOTENCY_TTL` | `86400` | Redis key TTL（秒），默认 24 小时 |
| `QUEUE_LOCAL_IDEMPOTENCY_LIMIT` | `1000` | 本地缓存最大条目数 |

### 启用 Redis 分布式去重

```bash
QUEUE_USE_IDEMPOTENCY=true
QUEUE_IDEMPOTENCY_TTL=86400    # 可选，默认 24 小时
```

### 兼容旧版本

旧变量 `QSTASH_PROCESSED_MESSAGES_LIMIT` 仍然有效，但推荐使用新变量 `QUEUE_LOCAL_IDEMPOTENCY_LIMIT`。

## 实现细节

### 消息 ID 生成

```javascript
// CloudQueueBase._generateMessageId()
const hash = md5(`${topic}:${content}`);
return `msg_${hash}`;
```

- 基于 `topic` + 消息内容生成 MD5 哈希
- 相同消息总是生成相同 ID

### 本地缓存 (CloudQueueBase)

```javascript
this.processedMessages = new Set();
this.processedMessagesLimit = 1000; // FIFO 驱逐
```

- 使用有界 Set 存储
- 超过上限时 FIFO 驱逐最旧条目
- 优点：零网络开销，极速检查
- 缺点：有内存上限，无 TTL

### Redis 分布式去重

```javascript
// 检查 key 是否存在
const existing = await redis.get(`queue:idempotency:${messageId}`);
if (existing) {
    return { duplicate: true };
}
// 设置 key 并设置 TTL
await redis.setex(`queue:idempotency:${messageId}`, ttl, '1');
```

- 跨实例共享状态
- 自动 TTL 过期
- 缺点：有网络开销

### 失败处理

```javascript
try {
    // 发布消息
} catch (error) {
    // 清理 Redis key，允许后续重试
    await this._clearIdempotencyKey(messageId);
    throw error;
}
```

- 发布失败时删除 Redis key
- 确保重试不会被误判为重复

## 监控

### 获取幂等性状态

```javascript
const status = queue.getIdempotencyStatus();
// {
//   localCache: { size: 150, limit: 1000 },
//   redis: { enabled: true, keyPrefix: 'queue:idempotency:', ttl: 86400 }
// }
```

### 指标

| 指标 | 说明 |
|------|------|
| `messages.duplicate` | 检测到的重复消息数 |

## 使用示例

### 基本使用

```javascript
import { QstashQueue } from './services/queue/index.js';

const queue = new QstashQueue();

// 发布消息（自动幂等性检查）
const result = await queue.publish('topic', { taskId: '123' });

// 检查是否为重复消息
if (result.duplicate) {
    console.log('消息已处理，跳过');
}
```

### 启用 Redis 分布式去重

```javascript
// 方式1: 环境变量
process.env.QUEUE_USE_IDEMPOTENCY = 'true';

const queue = new QstashQueue();

// 方式2: 构造函数
const queue = new QstashQueue({
    idempotencyEnabled: true,
    idempotencyTtl: 3600
});
```

### 监控

```javascript
// 获取队列状态
const status = queue.getQueueStatus();
console.log(status.idempotency);
// {
//   processedCount: 150,
//   limit: 1000
// }

// 获取详细幂等性状态
const idempotencyStatus = queue.getIdempotencyStatus();
```

## 故障排查

### 消息被误判为重复

1. **检查本地缓存是否已满**
   ```javascript
   queue.getIdempotencyStatus()
   // 如果 size 接近 limit，考虑增大 QUEUE_LOCAL_IDEMPOTENCY_LIMIT
   ```

2. **启用 Redis 分布式去重**
   ```bash
   QUEUE_USE_IDEMPOTENCY=true
   ```

3. **检查 Redis 连接**
   ```javascript
   queue.getIdempotencyStatus().redis.enabled
   // 应为 true
   ```

### 消息重复处理

1. **确保 Redis 可用**
   - 检查 `QUEUE_USE_IDEMPOTENCY=true`
   - 检查 Redis 连接状态

2. **检查 TTL 设置**
   - 如果消息重试间隔超过 TTL，需要增大 `QUEUE_IDEMPOTENCY_TTL`

### 性能问题

1. **本地缓存优先**
   - 默认使用本地缓存，无网络开销
   - Redis 仅作为分布式去重的后备

2. **调整缓存大小**
   - 高吞吐场景增大 `QUEUE_LOCAL_IDEMPOTENCY_LIMIT`
   - 权衡：内存使用 vs 重复检测准确性

## QStash 特有配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QSTASH_BATCH_SIZE` | `10` | 批量大小 |
| `QSTASH_BATCH_TIMEOUT` | `100` | 批量超时(ms) |
| `QSTASH_MAX_BUFFER_SIZE` | `1000` | 缓冲区上限 |
| `QSTASH_DLQ_SIZE` | `100` | 死信队列上限 |

## 相关文档

- [性能优化指南](./PERFORMANCE_OPTIMIZATION.md)
- [CONTRACT](./CONTRACT.md)
- [IMPLEMENTATION_SUMMARY](../IMPLEMENTATION_SUMMARY.md)
