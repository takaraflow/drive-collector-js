#!/bin/sh
# 诊断脚本：监控应用的信号和退出情况
# 使用方法：在容器中运行此脚本来监控Node进程

echo "=== Shutdown Diagnostics Tool ==="
echo "Monitoring Node.js process for signals and exits..."
echo ""

# 找到Node进程
NODE_PID=$(pgrep -f "node index.js" | head -1)

if [ -z "$NODE_PID" ]; then
    echo "❌ Node.js process not found"
    exit 1
fi

echo "✅ Found Node.js process: PID $NODE_PID"
echo ""

# 监控进程状态
echo "=== Process Info ==="
ps aux | grep -E "PID|$NODE_PID" | grep -v grep
echo ""

# 检查最近的s6日志
echo "=== Recent s6 Logs ==="
if [ -d /var/log/s6-rc ]; then
    find /var/log/s6-rc -type f -name "current" -exec tail -20 {} \;
fi
echo ""

# 检查finish脚本日志
echo "=== Finish Script Logs (last 50 lines) ==="
if command -v logread >/dev/null 2>&1; then
    logread | grep "s6-app-finish" | tail -50
else
    # 如果没有logread，尝试从标准输出读取
    echo "Note: Install busybox-syslog to see historical logs"
fi
echo ""

# 实时监控
echo "=== Monitoring for signals (Ctrl+C to stop) ==="
echo "Watching process $NODE_PID for changes..."
echo ""

while kill -0 "$NODE_PID" 2>/dev/null; do
    # 检查进程状态
    STATE=$(ps -o state= -p "$NODE_PID" 2>/dev/null)

    # 每5秒输出一次状态
    echo "[$(date -Iseconds)] Process $NODE_PID state: $STATE"

    sleep 5
done

# 进程已退出
echo ""
echo "⚠️  Process $NODE_PID has exited!"
echo ""

# 检查退出码
if [ -f /run/s6-linux-init-container-results/exitcode ]; then
    CONTAINER_EXIT=$(cat /run/s6-linux-init-container-results/exitcode)
    echo "Container exit code: $CONTAINER_EXIT"
fi

echo ""
echo "=== Last 30 lines of finish script output ==="
if command -v logread >/dev/null 2>&1; then
    logread | grep "s6-app-finish" | tail -30
fi
