# 管理员 API 文档

## 概述

本文档描述了 lb-worker-js 负载均衡器的管理员 API 接口，用于获取当前实例状态和监控信息。

## 安全性

管理员 API 使用基于 Token 的身份验证，确保只有授权的管理系统可以访问敏感信息。

### 认证方式

所有管理员 API 请求都需要在请求头中包含有效的管理员 Token：

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

或直接传递 Token：

```http
Authorization: <ADMIN_API_TOKEN>
```

### 配置要求

| 环境变量 | 说明 | 必需 | 示例 |
|---------|------|------|------|
| `ADMIN_API_TOKEN` | 管理员 API 访问令牌 | 是 | `your-secure-admin-token` |
| `SKIP_ADMIN_AUTH` | 跳过认证（仅开发环境） | 否 | `false` |

**安全建议**：
- 使用强密码或随机字符串作为 Token
- 定期轮换 Token
- 不要在代码中硬编码 Token
- 生产环境必须设置 `SKIP_ADMIN_AUTH=false`

---

## API 端点

### 1. 获取实例信息

获取当前负载均衡器的活跃实例状态和统计信息。

#### 端点信息

- **路径**: `/api/instances`
- **方法**: `GET`
- **认证**: 需要管理员 Token

#### 请求示例

```bash
curl -H "Authorization: Bearer your-admin-token" \
     https://lb-worker-js.example.com/api/instances
```

#### 成功响应 (200)

```json
{
  "status": "ok",
  "data": {
    "instances": [
      {
        "id": "instance-1",
        "url": "https://instance1.example.com",
        "hostname": "node-1",
        "status": "active",
        "lastHeartbeat": 1704700800000,
        "startedAt": 1704700000000,
        "region": "us-east-1"
      },
      {
        "id": "instance-2", 
        "url": "https://instance2.example.com",
        "hostname": "node-2",
        "status": "active",
        "lastHeartbeat": 1704700800000,
        "startedAt": 1704700000000,
        "region": "us-west-2"
      }
    ],
    "summary": {
      "total": 2,
      "provider": "Cloudflare KV",
      "lockKeys": 3,
      "timestamp": "2026-01-08T12:00:00.000Z"
    }
  }
}
```

#### 字段说明

##### instances 数组

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 实例唯一标识符 |
| `url` | string | 实例的完整 URL |
| `hostname` | string | 实例主机名 |
| `status` | string | 实例状态（active/inactive） |
| `lastHeartbeat` | integer | 最后心跳时间（Unix 毫秒时间戳） |
| `startedAt` | integer | 实例启动时间（Unix 毫秒时间戳） |
| `region` | string | 实例所在区域 |

##### summary 对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | integer | 活跃实例总数 |
| `provider` | string | 当前使用的缓存提供者 |
| `lockKeys` | integer | 当前锁键数量 |
| `timestamp` | string | 响应时间戳（ISO 8601 格式） |

#### 错误响应

##### 401 未授权

```json
{
  "status": "error",
  "message": "无效的 API Token",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

或

```json
{
  "status": "error", 
  "message": "缺少 Authorization 头",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

##### 500 内部错误

```json
{
  "status": "error",
  "message": "详细错误信息",
  "timestamp": "2026-01-08T12:00:00.000Z"
}
```

---

## 健康检查

健康检查端点不需要管理员认证，可用于监控负载均衡器的基本状态。

### 端点信息

- **路径**: `/health`
- **方法**: `GET`, `HEAD`
- **认证**: 无需

#### 请求示例

```bash
curl https://lb-worker-js.example.com/health
```

#### 响应示例 (200)

```json
{
  "status": "ok",
  "activeInstances": 2,
  "provider": "Cloudflare KV",
  "timestamp": "2026-01-08T12:00:00.000Z",
  "uptime": 1704700000
}
```

---

## 集成示例

### JavaScript/Node.js

```javascript
const API_BASE = 'https://lb-worker-js.example.com';
const ADMIN_TOKEN = 'your-admin-token';

async function getInstances() {
  try {
    const response = await fetch(`${API_BASE}/api/instances`, {
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`API Error: ${error.message}`);
    }

    const data = await response.json();
    console.log('活跃实例:', data.data.instances);
    console.log('统计信息:', data.data.summary);
    return data;
  } catch (error) {
    console.error('获取实例信息失败:', error);
    throw error;
  }
}

// 使用示例
getInstances();
```

### Python

```python
import requests
import json

API_BASE = 'https://lb-worker-js.example.com'
ADMIN_TOKEN = 'your-admin-token'

def get_instances():
    headers = {
        'Authorization': f'Bearer {ADMIN_TOKEN}',
        'Content-Type': 'application/json'
    }
    
    try:
        response = requests.get(f'{API_BASE}/api/instances', headers=headers)
        response.raise_for_status()
        
        data = response.json()
        print(f"活跃实例数量: {data['data']['summary']['total']}")
        print(f"缓存提供者: {data['data']['summary']['provider']}")
        
        for instance in data['data']['instances']:
            print(f"实例 {instance['id']}: {instance['url']} ({instance['status']})")
        
        return data
    except requests.exceptions.RequestException as e:
        print(f"API 请求失败: {e}")
        raise

# 使用示例
get_instances()
```

### cURL

```bash
# 获取实例信息
curl -H "Authorization: Bearer your-admin-token" \
     -H "Content-Type: application/json" \
     https://lb-worker-js.example.com/api/instances

# 健康检查
curl https://lb-worker-js.example.com/health
```

---

## 监控集成

### Prometheus 格式

虽然 LB Worker 不直接提供 Prometheus 端点，但可以通过管理员 API 获取指标：

```bash
# 获取指标
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://lb-worker-js.example.com/api/instances | \
     jq '.data.summary | {
       active_instances: .total,
       lock_keys: .lockKeys,
       provider: .provider
       }'
```

### Grafana Dashboard

可以基于以下指标创建 Grafana Dashboard：

- `active_instances`: 活跃实例数量
- `lock_keys`: 分布式锁数量
- `provider`: 使用的缓存提供者
- `heartbeat_age`: 实例心跳年龄

---

## 故障排除

### 常见问题

#### 1. Token 验证失败

**错误**: `401 Unauthorized`

**解决方案**:
- 检查 `ADMIN_API_TOKEN` 环境变量是否正确设置
- 确认请求头格式正确：`Authorization: Bearer <token>`
- 验证 Token 没有过期或被修改

#### 2. 无实例返回

**现象**: API 返回空的实例列表

**可能原因**:
- 没有实例注册到负载均衡器
- 实例心跳超时（超过 15 分钟）
- 缓存提供者连接问题

**排查步骤**:
1. 检查 `/health` 端点确认 LB Worker 运行正常
2. 查看实例是否正确注册：检查 `instance:*` 键
3. 检查实例心跳时间戳是否在有效范围内

#### 3. 开发环境认证问题

**问题**: 开发环境测试时认证失败

**解决方案**:
- 设置 `SKIP_ADMIN_AUTH=true` 跳过认证
- 或者配置 `ADMIN_API_TOKEN` 环境变量

### 调试信息

启用详细日志记录：

```bash
# 设置环境变量启用调试
export DEBUG_LOGS=true

# 查看请求日志
# 通过 Axiom 或其他日志系统查看 API 调用详情
```

关键日志标识：
- `Instance query` - 实例查询请求
- `管理员Token验证成功` - Token 验证成功
- `管理员Token验证失败` - Token 验证失败

---

## 版本信息

- **当前版本**: v0.15.4+
- **API 版本**: v1.0
- **兼容性**: 向后兼容，遵循语义化版本控制

---

**最后更新**: 2026-01-09  
**维护者**: shangxin <shangxin@outlook.com>