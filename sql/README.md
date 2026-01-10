# SQL 初始化脚本目录

此目录包含项目首次创建和 D1 数据库初始化所需的所有 SQL 语句。

## 文件说明

### 主要 SQL 文件

- **`init.sql`** - 完整的数据库初始化脚本，包含所有表的创建语句
- **`instances.sql`** - 实例表（用于管理多实例运行状态）
- **`tasks.sql`** - 任务表（用于存储文件传输任务）
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

## 注意事项

1. **主存储策略**：`settings` 和 `sessions` 表在生产环境中主要使用 Cache 作为主存储，D1 仅作为备份或特殊场景使用
2. **索引建议**：建议在 `user_id`、`status`、`created_at` 等常用查询字段上创建索引
3. **数据一致性**：使用 Write-Through 策略确保 Cache 和 D1 数据一致性
4. **性能优化**：对于高频查询，优先使用 Cache，D1 作为回源存储

## 首次部署步骤

1. 执行 `init.sql` 创建所有表
2. 配置环境变量（CF_D1_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_D1_TOKEN）
3. 启动应用，系统会自动初始化 Cache 服务
4. 如需迁移现有数据，运行 `scripts/migrate-drive-data.js`
