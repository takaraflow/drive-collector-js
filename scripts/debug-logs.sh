#!/bin/bash

# 实时查看应用日志的脚本
# 使用方法: ./debug-logs.sh

echo "🔍 开始调试日志监控..."

# 检查应用是否在运行
if pgrep -f "node.*index.js" > /dev/null; then
    echo "✅ 发现运行中的应用进程"
    echo "📊 实时日志输出 (Ctrl+C 退出):"
    echo "================================"
    
    # 实时查看日志，过滤关键信息
    tail -f logs/app.log 2>/dev/null | grep -E "(TaskManager|Dispatcher|MessageHandler|ERROR|WARN|🚀|📥|🔄|✅|❌)" || \
    tail -f /dev/null | grep -E "(TaskManager|Dispatcher|MessageHandler|ERROR|WARN|🚀|📥|🔄|✅|❌)" || \
    echo "⚠️ 未找到日志文件，尝试直接查看进程输出..."
    
else
    echo "❌ 未发现运行中的应用进程"
    echo "💡 请先启动应用: npm start"
fi