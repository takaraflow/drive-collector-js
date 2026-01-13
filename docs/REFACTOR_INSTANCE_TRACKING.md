# 实例追踪系统重构记录 (2026-01-14)

## 1. 重构背景
在早期的系统设计中，实例心跳和注册信息采用“双重写入”模式，同时存储在 Cloudflare D1 (SQL) 和分布式缓存 (Redis/KV) 中。随着系统演进，任务调度逻辑已完全转向基于缓存的实例发现，导致 D1 中的 `instances` 表成为冗余存储，增加了数据库写入压力和架构复杂度。

## 2. 变更详细行为

### 2.1 代码库修改
- **`src/repositories/InstanceRepository.js`**:
    - 彻底移除对 `d1` 服务的依赖。
    - 将所有数据操作重构为基于 `CacheService`。
    - 保留了原有的 API 签名 (`upsert`, `findAllActive`, `findById`, `updateHeartbeat`, `markOffline`, `getStats`) 以确保向下兼容。
    - 引入了 `timeoutMs` 参数支持，使超时控制更加灵活。
- **`src/services/InstanceCoordinator.js`**:
    - 移除了类中分散的直接 `cache.set('instance:...')` 调用。
    - 统一通过 `InstanceRepository` 静态方法进行实例生命周期管理。
    - 解耦了与 D1 相关的初始化逻辑。
- **`manifest.json`**:
    - 保持原版本号（4.23.0）。

### 2.2 数据库与 SQL 清理
- **`sql/init.sql`**: 移除了 `instances` 表及其索引的初始化定义。
- **`sql/instances.sql`**: 物理删除该文件。
- **D1 数据库 (手动项)**: 需要执行 `DROP TABLE IF EXISTS instances;`。

### 2.3 测试用例跟进
- **`__tests__/repositories/InstanceRepository.test.js`**: 重写为基于 Cache 的 Mock 测试，验证新的存储逻辑。
- **`__tests__/services/InstanceCoordinator.test.js`**: 修正了 Mock 逻辑，确保协调器与新 Repository 的集成无误。
- **`__tests__/services/instance_coordinator_dual_registration.test.js`**: 物理删除，因为“双重注册”机制已废弃。

## 3. 重构收益
1. **性能提升**: 消除心跳过程中的 SQL 写入，降低 D1 负载。
2. **架构简化**: 统一实例状态来源，消除“双头管理”导致的数据不一致风险。
3. **可靠性**: 利用 Cache 的 TTL (Time To Live) 机制，实现僵尸节点的自动清理，比原有的定时 SQL 删除更及时。

## 4. 后续追溯建议
如果在多实例发现或领导者选举中出现问题，请检查：
1. 缓存提供商（Valkey/Redis/KV）的连接稳定性。
2. `instance:` 前缀的键是否被意外清理。
3. `InstanceCoordinator` 产生的 `instanceId` 冲突情况。
