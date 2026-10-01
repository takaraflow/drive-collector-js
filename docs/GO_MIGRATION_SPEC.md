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
| `shadow:counts` | 可清(影子验证自己会重建) |
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
├─ main.go                 RUN_MODE: edge | shadow | both
├─ internal/
│  ├─ contract/            ✅ 已完成 —— 跨语言契约层
│  ├─ qstash/              ✅ 已完成 —— 签名验证
│  ├─ edge/                ✅ 已完成 —— webhook 边缘
│  ├─ leader/              ✅ 已完成 —— leader 解析
│  ├─ shadow/              ✅ 已完成 —— 影子模式 + diff
│  ├─ tgsession/           ✅ 已完成 —— gramjs session 解析
│  ├─ shadowfingerprint/   ✅ 已完成 —— 指纹契约
│  ├─ telegram/            🔜 本阶段 —— MTProto 客户端
│  ├─ task/                🔜 本阶段 —— 任务编排
│  ├─ drive/               🔜 本阶段 —— Mega + Proton
│  ├─ rclone/              🔜 本阶段 —— 进程调度
│  └─ store/               🔜 本阶段 —— D1 直连 + Redis
```

**预估:约 3000 行 Go,对比现在 2.5 万行 JS。**

---

## 四、执行顺序(每步可独立验证、可回滚)

### 阶段 A:存储层(2 周)
D1 直连 + Redis 归一化。

**为什么先做**:纯 I/O 封装,零业务逻辑,风险最低。
**验收**:Go 能读写 tasks/drives/settings 表,数据与 Node 双向一致。

### 阶段 B:任务编排(2 周)
TaskManager → Go,状态机已有跨语言向量保护。

**验收**:同一批任务,Go 处理结果与 Node 逐条比对一致。

### 阶段 C:网盘层(1 周)
Mega + Proton + rclone 调度。

**验收**:真实网盘跑通上传下载;Proton 的 10013 自愈有测试覆盖。

### 阶段 D:Telegram 客户端(3 周)
唯一的高风险阶段。

**前置条件**:影子模式跑满 2 周且 `Match=true`。
**验收**:Go 独立跑通全流程;Node 镜像保留 2 周但不接流量。

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
| 影子 diff 长期 Match=false | 已修窗口对齐;若仍不绿,先查两侧 update 流,不通则不进阶段 D |
| Proton session 处理出错 → 账号砖化 | 保留 `_driveSessionMutex` 的等价实现 + 10013 回归测试 |
| Telegram 连接病理无法验证 | 影子模式是唯一手段;`Match=true` 是硬门槛 |
| D1 数据格式 | 已验证纯 TEXT/INTEGER,零转换成本 |
| 回滚 | 阶段 A-C 每步都可切回 Node;阶段 D 后 Node 保留 2 周 |