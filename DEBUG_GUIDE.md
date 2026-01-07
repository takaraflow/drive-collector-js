# 📋 文件处理问题调试指南

## 🚨 问题现象
Bot收到文件后显示"🚀 已捕获文件任务 正在排队处理..."但没有后续进展。

## 🔍 快速诊断步骤

### 1. 运行诊断脚本
```bash
# Windows
scripts\debug-logs.bat

# Linux/Mac
./scripts/debug-logs.sh
```

### 2. 检查任务状态
```bash
node scripts/check-task-status.js
```

### 3. 诊断具体问题
```bash
node scripts/diagnose-file-issue.js
```

### 4. 实时监控
```bash
node scripts/monitor-tasks.js
```

## 📊 常见问题及解决方案

### 问题1: 有排队任务但没有处理器
**症状**: 
- 数据库中有 `queued` 状态的任务
- 没有 `downloading` 或 `uploading` 状态的任务

**可能原因**:
- TaskManager 未启动
- 处理器实例未获取到任务
- 任务认领机制有问题

**解决方案**:
```bash
# 1. 检查 TaskManager 日志
tail -f logs/app.log | grep "TaskManager"

# 2. 重启处理器
npm run start:processor

# 3. 检查实例协调器
tail -f logs/app.log | grep "InstanceCoordinator"
```

### 问题2: 任务卡在处理状态
**症状**:
- 任务长时间处于 `downloading` 或 `uploading` 状态
- 超过5分钟没有更新

**可能原因**:
- 网络连接问题
- Rclone 配置错误
- 磁盘空间不足
- 远程存储服务问题

**解决方案**:
```bash
# 1. 检查网络连接
ping -c 3 google.com

# 2. 检查 Rclone 配置
rclone config show

# 3. 检查磁盘空间
df -h

# 4. 查看详细错误日志
tail -f logs/app.log | grep -E "(ERROR|WARN|download|upload)"
```

### 问题3: 任务失败
**症状**:
- 任务状态变为 `failed`
- 有错误信息记录

**解决方案**:
```bash
# 1. 查看失败任务的错误信息
node scripts/diagnose-file-issue.js

# 2. 检查文件权限
ls -la /path/to/download/dir

# 3. 检查远程存储配置
# 检查 Rclone remote 配置是否正确
```

## 🔧 高级调试技巧

### 1. 启用详细日志
```bash
# 复制调试配置
cp .env.debug .env

# 重启应用
npm start
```

### 2. 手动检查数据库
```bash
# 查看最近的任务
node -e "
import { d1 } from './src/services/d1.js';
d1.fetchAll('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 5').then(console.log);
"
```

### 3. 检查缓存状态
```bash
# 查看缓存中的任务锁
node -e "
import { cache } from './src/services/CacheService.js';
cache.listKeys('lock:task:').then(console.log);
"
```

### 4. 检查处理器实例
```bash
# 查看活跃的处理器实例
node -e "
import { cache } from './src/services/CacheService.js';
cache.listKeys('instance:').then(console.log);
"
```

## 📝 日志关键词

### 关键日志关键词
- `TaskManager` - 任务管理器日志
- `Dispatcher` - 消息分发日志
- `MessageHandler` - 消息处理日志
- `ERROR` - 错误日志
- `WARN` - 警告日志
- `🚀` - 任务捕获日志
- `📥` - 消息接收日志
- `🔄` - 处理开始日志
- `✅` - 成功日志
- `❌` - 失败日志

### 过滤日志示例
```bash
# 查看所有任务相关日志
tail -f logs/app.log | grep -E "(TaskManager|Dispatcher|MessageHandler)"

# 查看错误和警告
tail -f logs/app.log | grep -E "(ERROR|WARN)"

# 查看特定用户的日志
tail -f logs/app.log | grep "用户ID: 123456"

# 查看文件处理日志
tail -f logs/app.log | grep -E "(🚀|📥|🔄|✅|❌)"
```

## 🛠️ 手动修复步骤

### 1. 清理卡住的任务
```bash
# 将卡住的任务重置为排队状态
node -e "
import { d1 } from './src/services/d1.js';
d1.run('UPDATE tasks SET status = \"queued\" WHERE status IN (\"downloading\", \"uploading\") AND updated_at < ?', [Date.now() - 10 * 60 * 1000]).then(() => console.log('已重置卡住的任务'));
"
```

### 2. 清理缓存锁
```bash
# 清理过期的任务锁
node -e "
import { cache } from './src/services/CacheService.js';
cache.listKeys('lock:task:').then(async (keys) => {
    for (const key of keys) {
        await cache.delete(key);
    }
    console.log('已清理所有任务锁');
});
"
```

### 3. 重启特定组件
```bash
# 只重启处理器
npm run start:processor

# 只重启分发器
npm run start:dispatcher

# 重启整个应用
npm start
```

## 📞 获取帮助

如果以上步骤都无法解决问题，请提供以下信息：

1. **运行诊断脚本的输出**
   ```bash
   node scripts/diagnose-file-issue.js
   ```

2. **相关日志片段**
   ```bash
   tail -n 50 logs/app.log | grep -E "(ERROR|WARN|TaskManager)"
   ```

3. **系统环境信息**
   - 操作系统版本
   - Node.js 版本
   - 应用版本

4. **复现步骤**
   - 发送什么类型的文件
   - 文件大小
   - 发送时间

这样可以帮助快速定位和解决问题！