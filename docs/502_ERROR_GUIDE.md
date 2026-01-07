# 🔍 LB 收到 502 错误诊断指南

## 502 Bad Gateway 常见原因

### 代码分析结果
**当前代码返回的状态码**:
- `200` - 成功
- `404` - 任务/消息未找到  
- `503` - Service Unavailable（非Leader、超时、缓存问题）
- `500` - 内部错误（数据库、其他）

**注意**: 代码中没有明确返回 `502`，所以 502 是 LB 层面的错误。

### 502 的真实原因

当 LB 收到 502 时，通常是因为：
1. **实例完全无响应** - LB 向实例发送请求，但实例没有回复
2. **实例崩溃/未启动** - 进程不存在
3. **网络问题** - LB 无法连接到实例
4. **健康检查超时** - LB 的健康检查失败
5. **实例重启中** - 实例正在重启，暂时无法响应

---

## 🔍 关键区别：503 vs 502

### 503 - Service Unavailable
**来源**: 代码明确返回
**场景**:
- 实例没有 `telegram_client` 锁（非 Leader）
- 任务超时
- 缓存服务异常

**日志示例**:
```json
{
  "statusCode": 503,
  "message": "Service Unavailable - Not Leader"
}
```

### 502 - Bad Gateway
**来源**: LB 判断
**场景**:
- 实例完全无响应
- 网络连接失败
- 实例崩溃
- 端口未监听

**日志示例**:
```
LB日志: [error] 502 Bad Gateway: backend returned no response
应用日志: 无日志（因为请求未到达应用）
```

---

## 🎯 502 错误的可能原因

### 1. 实例未响应或崩溃
**症状**: LB 向实例发送请求，但实例没有响应

**可能原因**:
- 实例进程崩溃
- 实例未正确启动
- 实例过载导致无法响应

**排查方法**:
```bash
# 检查实例进程是否运行
ps aux | grep node

# 检查实例日志
tail -f logs/app.log | grep -E "(ERROR|FATAL|crash)"

# 检查崩溃堆栈
dmesg | grep -i "killed process"
```

### 2. 健康检查失败
**症状**: LB 的健康检查检测到实例不可用

**可能原因**:
- `/health` 端点超时
- 实例没有监听正确端口
- 防火墙阻止健康检查

**健康检查实现** (index.js:16-28):
```javascript
if (url.pathname === healthPath) {
    res.writeHead(200);
    res.end('OK');
    return;
}
```

**排查方法**:
```bash
# 测试健康检查
curl http://localhost:3000/health

# 检查端口是否监听
netstat -tuln | grep 3000

# 检查防火墙
iptables -L | grep 3000
```

### 3. 网络连接问题
**症状**: LB 无法连接到实例

**可能原因**:
- 实例网络配置错误
- 防火墙规则阻止
- DNS 解析问题

**排查方法**:
```bash
# 测试网络连通性
ping <instance-ip>
telnet <instance-ip> 3000

# 检查网络接口
ifconfig
ip addr show

# 测试 DNS
nslookup <instance-hostname>
```

### 4. 实例过载
**症状**: 实例响应太慢，LB 判定为不可用

**可能原因**:
- CPU 使用率 100%
- 内存不足
- 处理大量并发请求

**排查方法**:
```bash
# 检查系统资源
top
htop

# 检查进程资源使用
ps aux | grep node | sort -k3 -rn

# 检查内存使用
free -h
```

### 5. 实例正在重启
**症状**: LB 请求时实例正在重启中

**可能原因**:
- 部署更新
- 崩溃后自动重启
- 健康检查触发重启

**排查方法**:
```bash
# 查看进程启动时间
ps -o etime= -p <pid>

# 查看最近的进程重启
uptime
last reboot

# 检查 systemd 服务
systemctl status your-service
```

---

## 🛠️ 诊断步骤

### 1. 检查实例状态
```bash
# 检查 Node.js 进程
ps aux | grep "node.*index.js"

# 检查端口监听
netstat -tuln | grep 3000  # 或你配置的端口

# 检查最近的错误日志
tail -n 100 logs/app.log | grep -E "(ERROR|FATAL|exception)"
```

### 2. 检查健康检查
```bash
# 直接测试健康端点
curl -v http://localhost:3000/health

# 从外部测试（如果可能）
curl -v http://<public-ip>:3000/health

# 检查响应时间
time curl http://localhost:3000/health
```

### 3. 检查日志中的503错误
```bash
# 查看503错误（LB可能看到的）
axiom query '_app="drive-collector" AND "Service Unavailable"' --since 1h

# 查看超时错误
axiom query '_app="drive-collector" AND (timeout OR TIMEOUT)' --since 1h

# 查看缓存问题
axiom query '_app="drive-collector" AND (cache OR lock OR kv)' --since 1h
```

### 4. 检查实例协调器
```bash
# 查看实例锁状态
axiom query '_app="drive-collector" AND "telegram_client"' --since 1h

# 查看实例协调器日志
axiom query '_app="drive-collector" AND InstanceCoordinator' --since 1h
```

### 5. 检查系统资源
```bash
# CPU使用
top -bn1 | grep "Cpu(s)"

# 内存使用
free -h

# 磁盘使用
df -h

# 网络连接
netstat -an | grep ESTABLISHED | wc -l
```

---

## 🎯 常见502场景及解决方案

### 场景1: 实例刚启动
**原因**: 实例启动中，健康检查还未通过

**解决方案**:
- LB 配置中增加启动延迟
- 增加健康检查超时时间
- 配置 LB 的 `initial_delay_seconds`

### 场景2: 实例过载
**原因**: 并发请求数超过实例处理能力

**解决方案**:
```bash
# 查看并发数
axiom query '_app="drive-collector" AND webhook' --since 5m | wc -l

# 限制并发
# 在配置中设置限流
```

### 场景3: 健康检查间隔太短
**原因**: LB 健康检查频率过高，实例来不及响应

**解决方案**:
- 增加健康检查间隔
- 降低健康检查频率
- 使用更轻量级的健康检查

### 场景4: 实例崩溃
**原因**: 应用崩溃，进程退出

**解决方案**:
```bash
# 查找崩溃原因
axiom query '_app="drive-collector" AND (FATAL|uncaught|crash)' --since 1h

# 启用自动重启
# 使用 systemd 或进程管理器
systemd service configuration
```

---

## 📋 LB 配置建议

### 健康检查配置
```yaml
# 建议配置示例
health_check:
  path: /health
  interval: 30s           # 检查间隔
  timeout: 5s             # 超时时间
  unhealthy_threshold: 3    # 连续失败次数
  healthy_threshold: 2      # 连续成功次数
  initial_delay: 60s       # 启动延迟
```

### 超时配置
```yaml
timeout_settings:
  connect_timeout: 5s     # 连接超时
  send_timeout: 30s        # 发送超时
  read_timeout: 30s         # 读取超时
```

### 重试策略
```yaml
retry_policy:
  num_retries: 3            # 重试次数
  backoff: exponential       # 退避策略
  retry_on: 5xx             # 只在5xx时重试
```

---

## 🔍 实时监控脚本

### 创建502监控脚本
```bash
#!/bin/bash
# monitor-502.sh - 监控502错误

echo "监控502错误中..."

while true; do
    # 查询最近1分钟的502错误
    count=$(axiom query '_app="drive-collector" AND "502"' --since 1m --count 2>/dev/null || echo "0")
    
    if [ "$count" -gt 0 ]; then
        echo "[$(date)] ⚠️ 发现 $count 个502错误"
        
        # 获取详细信息
        axiom query '_app="drive-collector" AND "502"' --since 1m --format="json" \
            | jq -r '. | "\(.["@timestamp"]) \(.msg)"' | head -5
    fi
    
    sleep 60  # 每分钟检查一次
done
```

### 创建实例健康检查脚本
```bash
#!/bin/bash
# check-instance-health.sh - 检查实例健康

PORT=${1:-3000}

echo "检查实例健康状态 (端口 $PORT)..."

# 1. 检查进程
if ! pgrep -f "node.*index.js" > /dev/null; then
    echo "❌ 进程未运行"
    exit 1
fi

# 2. 检查端口
if ! netstat -tuln | grep -q ":$PORT "; then
    echo "❌ 端口未监听"
    exit 1
fi

# 3. 检查健康端点
if ! curl -s http://localhost:$PORT/health > /dev/null; then
    echo "❌ 健康检查失败"
    exit 1
fi

# 4. 检查资源
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
MEM_USAGE=$(free | grep Mem | awk '{printf("%.1f", $3/$2 * 100.0)}')

echo "✅ 实例健康"
echo "CPU: ${CPU_USAGE}%"
echo "内存: ${MEM_USAGE}%"

if (( $(echo "$CPU_USAGE > 90" | bc -l) )); then
    echo "⚠️ CPU使用率过高"
fi

if (( $(echo "$MEM_USAGE > 90" | bc -l) )); then
    echo "⚠️ 内存使用率过高"
fi
```

---

## 📞 获取帮助时提供的信息

如果你遇到持续的502错误，请提供：

1. **实例状态**
   ```bash
   ps aux | grep node
   netstat -tuln | grep 3000
   top -bn1
   ```

2. **健康检查结果**
   ```bash
   curl -v http://localhost:3000/health
   ```

3. **相关日志**
   ```bash
   tail -n 100 logs/app.log
   axiom query '_app="drive-collector" AND (502 OR timeout)' --since 1h
   ```

4. **LB配置**
   - 健康检查配置
   - 超时设置
   - 重试策略

5. **环境信息**
   - 实例类型（VM/容器）
   - 系统配置（CPU/内存）
   - 网络配置

这样可以快速定位502问题的根本原因！