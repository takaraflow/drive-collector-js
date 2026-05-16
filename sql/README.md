# SQL 初始化脚本目录

此目录包含项目首次创建和 D1 数据库初始化所需的所有 SQL 语句。

## 文件说明

### 主要 SQL 文件

- **`init.sql`** - 完整的数据库初始化脚本，包含所有表的创建语句
- **`schema-migrations.sql`** - schema 版本和迁移锁表（由 `db:migrate` 维护）
- **`instances.sql`** - 实例表（用于管理多实例运行状态）
- **`tasks.sql`** - 任务表（用于存储文件传输任务）
- **`migrate-tasks-status-ssot.sql`** - 既有 tasks 表状态约束收口迁移（已纳入 `db:migrate`）
- **`migrate-drives-default-ssot.sql`** - 既有 drives 表默认盘 SSOT 迁移（已纳入 `db:migrate`）
- **`drives.sql`** - 网盘配置表（用于存储用户绑定的网盘信息）
- **`settings.sql`** - 系统设置表（仅作为备份或特殊场景使用）
- **`sessions.sql`** - 会话表（仅作为备份或特殊场景使用）

### 使用说明

#### 方式一：使用完整初始化脚本（推荐）
```bash
# 执行 init.sql 创建所有表
# 注意：需要根据你的 D1 配置调整执行方式
```

#### 方式二：按需创建表
```bash
# 仅创建需要的表
# 例如：仅创建 instances 和 tasks 表
```

#### 方式三：数据库版本校验与自动迁移
```bash
# 查看当前 schema 版本和缺失项
npm run db:status

# 只校验，不改库；应用启动默认也会做这个校验
npm run db:check

# 自动执行尚未应用的迁移，并写入 schema_migrations
npm run db:migrate

# 演练待执行项，不改库
npm run db:migrate:dry
```

应用启动默认只做 schema 版本校验，发现缺失迁移会 fail-fast 并提示先执行 `npm run db:migrate`。如需在启动阶段显式自动迁移，设置 `DB_AUTO_MIGRATE=true`；这适合受控部署步骤，不建议作为排查问题时的隐式兜底。`DB_SCHEMA_CHECK=false` 只用于紧急诊断，正常环境不要关闭。

## 表结构说明

### instances 表
用于管理多实例运行状态，支持多实例部署时的协调和监控。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 实例ID（主键） |
| hostname | TEXT | 主机名 |
| region | TEXT | 区域 |
| started_at | INTEGER | 启动时间戳 |
| last_heartbeat | INTEGER | 最后心跳时间 |
| status | TEXT | 状态（active/offline） |
| created_at | INTEGER | 创建时间 |
| updated_at | INTEGER | 更新时间 |

### tasks 表
用于存储文件传输任务，支持任务状态跟踪和实例认领。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 任务ID（主键） |
| user_id | TEXT | 用户ID |
| chat_id | TEXT | 聊天ID |
| msg_id | INTEGER | 消息ID |
| source_msg_id | INTEGER | 源消息ID |
| file_name | TEXT | 文件名 |
| file_size | INTEGER | 文件大小 |
| status | TEXT | 任务状态 |
| error_msg | TEXT | 错误信息 |
| claimed_by | TEXT | 认领实例ID |
| created_at | INTEGER | 创建时间 |
| updated_at | INTEGER | 更新时间 |

### drives 表
用于存储用户绑定的网盘配置信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 网盘ID（主键） |
| user_id | TEXT | 用户ID |
| name | TEXT | 网盘别名 |
| type | TEXT | 网盘类型 |
| config_data | TEXT | 配置数据（JSON） |
| status | TEXT | 状态（active/deleted） |
| created_at | INTEGER | 创建时间 |
| updated_at | INTEGER | 更新时间 |

### settings 表
用于存储系统配置项（注意：主存储在 Cache 中）

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT | 配置键（主键） |
| value | TEXT | 配置值 |
| created_at | INTEGER | 创建时间 |
| updated_at | INTEGER | 更新时间 |

### sessions 表
用于存储用户会话状态（注意：主存储在 Cache 中）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 会话ID（主键） |
| user_id | TEXT | 用户ID |
| data | TEXT | 会话数据（JSON） |
| created_at | INTEGER | 创建时间 |
| expires_at | INTEGER | 过期时间 |

### schema_migrations 表
用于记录已应用的数据库 schema 迁移版本。应用启动依赖此表判断数据库结构是否满足当前代码。

| 字段 | 类型 | 说明 |
|------|------|------|
| version | INTEGER | 迁移版本（主键） |
| name | TEXT | 迁移名称 |
| checksum | TEXT | 迁移内容摘要 |
| applied_at | INTEGER | 应用时间 |
| execution_time_ms | INTEGER | 执行耗时 |

## 注意事项

1. **主存储策略**：`settings` 和 `sessions` 表在生产环境中主要使用 Cache 作为主存储，D1 仅作为备份或特殊场景使用
2. **索引建议**：建议在 `user_id`、`status`、`created_at` 等常用查询字段上创建索引
3. **数据一致性**：使用 Write-Through 策略确保 Cache 和 D1 数据一致性
4. **性能优化**：对于高频查询，优先使用 Cache，D1 作为回源存储

## 首次部署步骤

1. 配置环境变量（`CLOUDFLARE_D1_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN`）
2. 执行 `npm run db:migrate` 初始化或迁移数据库
3. 执行 `npm run db:check` 确认 schema 版本已达最新
4. 启动应用，系统会自动初始化 Cache 服务并再次校验 schema 版本
5. 如需迁移旧 Cache 网盘数据，运行 `scripts/migrate-drive-data.js`
