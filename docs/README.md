# Cache Service

## 配置示例

### 环境变量配置

```bash
# CACHE_PROVIDERS JSON 配置
export CACHE_PROVIDERS='[
  {
    "name":"Cloudflare-Primary",
    "type":"cloudflare-kv",
    "priority":1,
    "accountId":"${CF_ACCOUNT_ID}",
    "namespaceId":"${CF_NAMESPACE_ID}",
    "token":"${CF_TOKEN}"
  },
  {
    "name":"Redis-Internal-Backup",
    "type":"redis",
    "priority":2,
    "host":"${REDIS_HOST}",
    "port":6379,
    "password":"${REDIS_PASSWORD}",
    "tls": {
      "enabled": true,
      "rejectUnauthorized": true,
      "servername":"redis.internal"
    },
    "replicas": [
      {"host":"replica1.internal","port":6379},
      {"host":"replica2.internal","port":6379}
    ]
  }
]'

# 可选：强制使用特定 provider
export PRIMARY_CACHE="Redis-Internal-Backup"
```

### 配置字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| name | 是 | 提供商唯一标识 |
| type | 是 | 类型: `cloudflare-kv`, `redis` |
| priority | 否 | 优先级，值越小越高，默认 99 |
| accountId | KV必填 | Cloudflare Account ID |
| namespaceId | KV必填 | Cloudflare KV Namespace ID |
| token | KV必填 | Cloudflare API Token |
| host | Redis必填 | Redis 主机地址 |
| port | Redis必填 | Redis 端口 |
| password | 否 | Redis 密码 |
| username | 否 | Redis 用户名 |
| db | 否 | Redis 数据库编号，默认 0 |
| tls.enabled | 否 | 是否启用 TLS |
| tls.rejectUnauthorized | 否 | 是否拒绝未授权证书 |
| tls.servername | 否 | SNI 服务器名 |
| replicas | 否 | 预留字段，暂不支持 |

## 使用方式

```javascript
import { cacheService } from './cache/index.js';

async function example(env) {
  // 初始化（首次调用会自动初始化）
  await cacheService.initialize({ env });
  
  // 获取值
  const value = await cacheService.get('myKey', 'json');
  
  // 设置值
  await cacheService.set('myKey', { foo: 'bar' }, 3600);
  
  // 删除值
  await cacheService.delete('myKey');
  
  // 获取当前 provider
  const provider = cacheService.getCurrentProvider();
  
  // 获取连接信息
  const info = cacheService.getConnectionInfo();
}
```

## 向后兼容

原有 API 保持不变：
- `getNFCacheClient(env)` - 继续可用
- `CacheTLSClient` - 继续可用
- `NFCacheClient` - 继续可用

## 优先级选择逻辑

1. 如果设置了 `PRIMARY_CACHE` 环境变量，优先使用匹配的提供商
2. 否则按 `priority` 字段升序排序选择
3. 如果所有 provider 都连接失败，降级到内存缓存
