# 迁移规格:单实例 + 双网盘精简版

> 决策:单实例运行、只保留 **Mega + Proton**、其他网盘留占位后续补。
> 目标不是「把 JS 翻译成 Go」,是**只迁必要功能,砍掉历史包袱**。

---

## 一、砍掉什么(留占位,不删代码)

### 1. Drive provider:11 → 2

| 保留 | 理由 |
|---|---|
| **Mega** | 已实测可用。绑定形态最简单:邮箱 + 密码 → rclone `mega` 后端 |
| **Proton** | 已实测可用。复杂度高但**必须留** —— 它有 session 生命周期管理 |

| 转占位(后续补) | 原始行数 |
|---|---|
| Box / Dropbox / PikPak / PCloud / OneDrive / GoogleDrive / WebDAV / OSS | 约 1400 |
| 其余 locale 文件 | 约 400 |

**占位形态**:注册表里保留 type 字符串,用户选到时回「暂未支持」,
不动现有 JS 实现,迁移完再逐个补。

> 关键:Mega 和 Proton 是**两种完全不同的绑定模型**。
> Mega 是「填两个字段」,Proton 是「四步流程 + session 续期」。
> 这个差异保留,不强行统一。

### 2. Cache provider:12 → 1

只留 Redis(带 TLS 开关)。其余按配置别名映射到同一个实现:

```
RedisTLSCache / ValkeyCache / NorthFlankRTCache / AivenVTCache
    → 全部是 RedisCache 的不同启动参数,归一化成配置项
```

`CacheService.js`(1541 行)→ 约 300 行。

### 3. 多实例协调:全部下线

单实例下这些不是「暂时不用」,是**永久不需要**:

| 现在 | 单实例后 |
|---|---|
| `telegram_client` 锁(90s TTL + 续期) | 进程内状态 |
| `DistributedLock`(612 行) | `sync.Mutex` |
| `InstanceCoordinator`(960 行) | 删 |
| `StateSynchronizer` / `ConsistentCache` 广播 | 删 |

**连带消失的历史包袱**:记忆里 `AUTH_KEY_DUPLICATED` 整条踩坑史
(PR#445/446/447/448)在单实例下不会发生 —— 没人跟它抢连接。

### 4. Redis 数据分类

| Key | 处置 |
|---|---|
| `setting:tg_bot_session` | **必须保留** —— 登录态,丢了要重新走 OTP 绑定 |
| `instance:*` | 可清(单实例不需要注册) |
| MediaGroupBuffer 的 key | **清理前先把队列跑空** —— 正在缓冲的媒体组会静默丢失 |

---

## 二、不能砍的三块

砍掉 88% 的代码,但这三块是**真实成本**:

### 1. Telegram 客户端核心(约 1500 行)

- 媒体组聚合(用户发 10 张图要能合并成一个任务)
- 流式传输 + 断点续传
- 连接看门狗 + 重连退避

砍这些 = **功能缺失**,不是架构精简。

### 2. Proton session 生命周期(约 400 行)

复杂度不在 OAuth 流程,在:
- `ensureRuntimeSession` —— 传输前确保 session 可用
- `mergeRuntimeSessionFromRemoteConfig` —— rclone 旋转后的 token 收割
- `invalidateStoredSession` —— `Code=10013` 自愈

配套的 `_driveSessionMutex`(rclone.js:51)—— 防止并发抢一次性 refresh_token
导致账号永久砖化。

**这是你们记忆里最贵的一条教训,必须原样保留。**

### 3. rclone 调度胶水(约 400 行)

Go 侧写法:

```go
cmd := exec.CommandContext(ctx, rcloneBinary, args...)
stderr, _ := cmd.StderrPipe()
scanner := bufio.NewScanner(stderr)   // rclone --use-json-log 的逐行 JSON
```

原 JS 200 行的 timeout + SIGKILL 样板塌缩到 20 行 —— 这是 Go 的真实收益。

但**数据不经过 Go 堆**:字节搬运在 rclone 进程里,那已经是 Go 了。

---

## 三、迁完长什么样

```
cmd/collector/
├─ main.go                RUN_MODE: edge | worker
└─ internal/
   ├─ contract/           跨语言契约(状态机 + 幂等键)
   ├─ qstash/             签名验证
   ├─ edge/               webhook 边缘节点
   ├─ leader/             leader 解析
   ├─ redisenv/           共享 Redis 配置
   ├─ tgsession/          gramjs session 解析
   ├─ d1/ + store/        D1 客户端 + 任务仓储
   ├─ task/               任务编排
   ├─ drive/              网盘层(Mega + Proton)
   ├─ rclone/             rclone 调度
   ├─ telegram/           MTProto 客户端
   └─ app/                编排层
```

**预估:约 3000 行 Go,对比现在 2.5 万行 JS。**

---

## 四、执行顺序与进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 契约层 | 跨语言向量(状态机 126 / 幂等键 648 / 验签 8 / 指纹 11 / session 9) | ✅ |
| 边缘节点 | 验签 → 解析 → 转发 leader | ✅ |
| 存储层 | D1 客户端 + 任务仓储(乐观锁) | ✅ |
| 任务编排 | 状态机驱动 + 503/200 分流 | ✅ |
| 网盘层 | Mega + Proton + SessionLock | ✅ |
| Telegram | MTProto 客户端 + 下载 + 归一化 | ✅ |
| 编排 | RUN_MODE=worker 端到端 | ✅ 代码完成,待线上验证 |

**当前规模:4708 行生产代码 + 4181 行测试(150 个用例),16 个包。**

### 上线方式

Go 直接接管,Node 镜像保留两周用于回滚。回滚 = 把 LB 指回 Node,
不需要重新构建任何东西。

**没有并行验证期。** Node 和 Go 不能同时连同一个 Telegram 账号 ——
那会触发 AUTH_KEY_DUPLICATED,把另一边踢下线。所以切换只能是原子的:
要么全 Go,要么全 Node。

代价说清楚:某些差异(少认一类 update、媒体组边界)只有在特定
条件下才出现,测试覆盖不到,只能等线上碰到。缓解手段是 Node 镜像
保留两周 —— 出事回滚,而不是等用户投诉。

**没有并行验证期。** Node 和 Go 不能同时连同一个 Telegram 账号 ——
那会触发 AUTH_KEY_DUPLICATED,把另一边踢下线。所以切换只能是原子的:
要么全 Go,要么全 Node。

代价说清楚:某些差异(少认一类 update、媒体组边界)只有在特定
条件下才出现,测试覆盖不到,只能等线上碰到。缓解手段是 Node 镜像
保留两周 —— 出事回滚,而不是等用户投诉。

---

## 五、不做的事

| 不做 | 原因 |
|---|---|
| 保留 Node 镜像 2 周后删除 | 多实例场景下可能需要回滚 |
| 迁移其余 9 个网盘 | 已确认只有 Mega/Proton 在用 |
| 保留分布式锁 | 单实例下是纯开销 |
| 保留跨实例广播 | 同上 |

---

## 六、风险与缓解

| 风险 | 缓解 |
|---|---|
| Proton session 处理出错 → 账号砖化 | 保留 `_driveSessionMutex` 的等价实现 + 10013 回归测试 |
| Telegram 连接病理无法提前验证 | 单实例下无并发竞争;出问题靠 Node 镜像回滚 |
| D1 数据格式 | 已验证纯 TEXT/INTEGER,零转换成本 |
| 回滚 | Node 镜像保留两周,把 LB 指回即可,无需重新构建 |