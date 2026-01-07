# 📊 Axiom 日志区分触发源指南

## 🎯 问题描述
如何区分任务是直接通过 QStash 发送的，还是通过 Load Balancer (LB) 转发的？

## 🔍 已实现的日志标记

### 1. 直接 QStash 发送
**触发方式**: `TaskManager.addTask()` → `_enqueueTask()` → QStash

**日志标记**:
```json
{
  "taskId": "xxx",
  "triggerSource": "direct-qstash",
  "instanceId": "instance_123", 
  "isFromQStash": true
}
```

**Axiom 查询**:
```bash
# 查看直接 QStash 发送的任务
_app="drive-collector" AND "direct-qstash"
_app="drive-collector" AND "isFromQStash:true"
```

### 2. Load Balancer 转发
**触发方式**: LB → HTTP Webhook → TaskManager.handleXxxWebhook()

**日志标记**:
```json
{
  "taskId": "xxx",
  "triggerSource": "unknown",
  "instanceId": "unknown",
  "isFromQStash": false
}
```

**Axiom 查询**:
```bash
# 查看LB转发的请求
_app="drive-collector" AND NOT "direct-qstash"
_app="drive-collector" AND "isFromQStash:false"
```

## 🛠️ 查询脚本

### Linux/Mac
```bash
# 查看所有 webhook 触发
./scripts/query-axiom-logs.sh webhook

# 查看下载任务的触发源
./scripts/query-axiom-logs.sh "download webhook"

# 查看上传任务的触发源  
./scripts/query-axiom-logs.sh "upload webhook"

# 查看最近2小时
./scripts/query-axiom-logs.sh webhook 2h

# 查看最近30分钟
./scripts/query-axiom-logs.sh webhook 30m
```

### Windows
```cmd
REM 查看所有 webhook 触发
scripts\query-axiom-logs.bat webhook

REM 查看下载任务的触发源
scripts\query-axiom-logs.bat "download webhook"

REM 查看最近2小时
scripts\query-axiom-logs.bat webhook 2h
```

## 📈 手动 Axiom 查询

### 基础查询
```bash
# 安装 axiom CLI
curl -sSf https://sh.axiom.com/install | sh

# 登录
axiom login <your-token>

# 查询触发源
axiom query '_app="drive-collector" AND triggerSource' --since 2h
```

### 高级查询
```bash
# QStash 直接发送的任务
axiom query '_app="drive-collector" AND "triggerSource:direct-qstash"' --since 2h

# LB 转发的任务
axiom query '_app="drive-collector" AND NOT "triggerSource:direct-qstash"' --since 2h

# 按实例分组
axiom query '_app="drive-collector" AND instanceId' --since 2h \
    | jq '.instanceId' | sort | uniq -c

# 最近任务的时间线
axiom query '_app="drive-collector" AND (taskId AND triggerSource)' --since 2h \
    --format="json" \
    | jq -r '. | select(.taskId) | "\(.["@timestamp"]) 任务:\(.taskId) 来源:\(.triggerSource)"' \
    | head -20
```

## 📊 日志分析示例

### 检查重复处理
```bash
# 检查同一任务是否被多次触发
axiom query '_app="drive-collector" AND taskId' --since 1h \
    | jq -r '.taskId' | sort | uniq -d

# 查看特定任务的生命周期
axiom query '_app="drive-collector" AND "task-12345"' --since 1h \
    --format="json" \
    | jq -r '. | "\(.["@timestamp"]) \(.msg)"'
```

### 检查实例分布
```bash
# 查看哪些实例在处理任务
axiom query '_app="drive-collector" AND "instanceId"' --since 1h \
    | jq -r '.instanceId // "unknown"' | sort | uniq -c

# 检查实例健康度
axiom query '_app="drive-collector" AND ("start" OR "shutdown")' --since 24h
```

### 性能分析
```bash
# 查看任务处理延迟
axiom query '_app="drive-collector" AND ("enqueued" AND "download webhook")' --since 2h \
    --format="json" \
    | jq -r '. | "\(.taskId) 入队:\(.["@timestamp"]) 下载开始: ..."' 

# 查看错误率
axiom query '_app="drive-collector" AND ("ERROR" OR "failed")' --since 1h \
    | jq -r '.msg' | grep -c "failed"
```

## 🎯 实际使用场景

### 场景1: 任务卡住不处理
```bash
# 1. 查看任务创建和下载开始的时间差
./scripts/query-axiom-logs.sh "enqueued" 1h
./scripts/query-axiom-logs.sh "download webhook" 1h

# 2. 检查是否有下载处理器在运行
./scripts/query-axiom-logs.sh "QStash Received download" 30m
```

### 场景2: 怀疑重复处理
```bash
# 1. 查看同一taskId的多次触发
axiom query '_app="drive-collector" AND "task-12345"' --since 30m

# 2. 查看哪些实例在处理同一任务
axiom query '_app="drive-collector" AND "task-12345"' --since 30m \
    | jq '.instanceId // "unknown"' | sort | uniq
```

### 场景3: 性能调优
```bash
# 1. 统计直接QStash vs LB转发比例
./scripts/query-axiom-logs.sh webhook 1h

# 2. 分析处理延迟
axiom query '_app="drive-collector" AND (enqueued AND webhook)' --since 1h \
    --format="json" | jq '. | {time: .["@timestamp"], source: .triggerSource, task: .taskId}'
```

## 📝 关键日志标识

### 🎯 触发源标识
- `"triggerSource": "direct-qstash"` - 直接通过 QStash 发送
- `"triggerSource": "unknown"` - LB 转发或其他
- `"isFromQStash": true/false` - 是否来自 QStash
- `"instanceId": "xxx"` - 发送实例ID

### 🏠 实例标识
- `"instanceId": "instance_xxx"` - 有INSTANCE_ID的环境变量
- `"instanceId": "unknown"` - 无实例ID（通常来自LB转发）

### 📊 任务状态
- `"enqueued"` - 任务已入队
- `"QStash Received download webhook"` - 下载处理开始
- `"QStash Received upload webhook"` - 上传处理开始
- `"completed"` - 任务完成
- `"failed"` - 任务失败

## 🛠️ 故障排查

### 1. 没有看到 "direct-qstash" 日志
- 检查 TaskManager 是否正确调用 `_enqueueTask`
- 检查 QStash 配置是否正确
- 查看 Mock Mode 日志

### 2. 看到重复的触发源
- 检查 LB 健康检查配置
- 检查实例协调器是否正常工作
- 查看实例锁状态

### 3. 实例ID显示为 unknown
- 检查 INSTANCE_ID 环境变量设置
- 查看容器启动配置
- 检查 Kubernetes/Cloudflare 配置

现在你可以通过这些日志标记清晰地区分任务的触发来源了！