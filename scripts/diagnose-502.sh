#!/bin/bash

# 502错误快速诊断脚本
# 使用方法: ./diagnose-502.sh [实例URL]

INSTANCE_URL=${1:-"http://localhost:3000"}

echo "🔍 502错误诊断工具"
echo "=================="
echo "实例URL: $INSTANCE_URL"
echo ""

# 1. 检查进程状态
echo "1️⃣ 检查进程状态..."
echo "-------------------"

if pgrep -f "node.*index.js" > /dev/null; then
    echo "✅ Node.js 进程运行中"
    PID=$(pgrep -f "node.*index.js")
    echo "   PID: $PID"
    
    # 检查进程启动时间
    START_TIME=$(ps -p $PID -o etime= | tr -d ' ')
    echo "   运行时间: $START_TIME"
    
    # 检查CPU和内存使用
    CPU_USAGE=$(ps -p $PID -o %cpu= | tr -d ' ')
    MEM_USAGE=$(ps -p $PID -o %mem= | tr -d ' ')
    echo "   CPU: ${CPU_USAGE}%"
    echo "   内存: ${MEM_USAGE}%"
    
    if (( $(echo "$CPU_USAGE > 80" | bc -l) )); then
        echo "   ⚠️ CPU使用率过高"
    fi
    
    if (( $(echo "$MEM_USAGE > 80" | bc -l) )); then
        echo "   ⚠️ 内存使用率过高"
    fi
else
    echo "❌ Node.js 进程未运行"
    echo "   💡 可能是导致502的原因"
fi

echo ""

# 2. 检查端口监听
echo "2️⃣ 检查端口监听..."
echo "-------------------"

PORT=$(echo $INSTANCE_URL | grep -oP ':\K[0-9]+')
if [ -z "$PORT" ]; then
    PORT="3000"
fi

if netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
    echo "✅ 端口 $PORT 正在监听"
else
    echo "❌ 端口 $PORT 未监听"
    echo "   💡 可能是导致502的原因"
fi

echo ""

# 3. 检查健康检查
echo "3️⃣ 检查健康端点..."
echo "-------------------"

HEALTH_URL="$INSTANCE_URL/health"
HEALTH_START=$(date +%s.%N)

if curl -s -f "$HEALTH_URL" > /dev/null 2>&1; then
    HEALTH_END=$(date +%s.%N)
    HEALTH_TIME=$(echo "$HEALTH_END - $HEALTH_START" | bc)
    echo "✅ 健康检查通过"
    echo "   响应时间: ${HEALTH_TIME}s"
    
    if (( $(echo "$HEALTH_TIME > 5" | bc -l) )); then
        echo "   ⚠️ 响应时间过长（>5s）"
        echo "   💡 可能导致LB判断为不健康"
    fi
else
    echo "❌ 健康检查失败"
    echo "   💡 可能是导致502的原因"
fi

echo ""

# 4. 测试webhook端点
echo "4️⃣ 测试webhook端点..."
echo "-------------------"

# 测试下载webhook
DOWNLOAD_WEBHOOK="$INSTANCE_URL/api/tasks/download-tasks"
if curl -s -f -X POST "$DOWNLOAD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d '{"taskId":"test"}' \
    --max-time 5 > /dev/null 2>&1; then
    echo "✅ 下载webhook可访问"
else
    echo "⚠️ 下载webhook响应异常"
    CURL_EXIT=$?
    echo "   退出码: $CURL_EXIT"
    echo "   💡 可能导致502"
fi

# 测试上传webhook
UPLOAD_WEBHOOK="$INSTANCE_URL/api/tasks/upload-tasks"
if curl -s -f -X POST "$UPLOAD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d '{"taskId":"test"}' \
    --max-time 5 > /dev/null 2>&1; then
    echo "✅ 上传webhook可访问"
else
    echo "⚠️ 上传webhook响应异常"
    CURL_EXIT=$?
    echo "   退出码: $CURL_EXIT"
    echo "   💡 可能导致502"
fi

echo ""

# 5. 检查最近错误
echo "5️⃣ 检查最近错误日志..."
echo "-------------------"

if [ -f "logs/app.log" ]; then
    echo "最近10个错误："
    grep -i "error\|fatal\|crash" logs/app.log | tail -10
    
    echo ""
    echo "最近503错误（非Leader）："
    grep "503\|Service Unavailable" logs/app.log | tail -5
else
    echo "⚠️ 未找到日志文件 logs/app.log"
fi

echo ""

# 6. 检查系统资源
echo "6️⃣ 检查系统资源..."
echo "-------------------"

# CPU使用
CPU_IDLE=$(top -bn1 | grep "Cpu(s)" | awk '{print $8}' | cut -d'%' -f1)
CPU_USAGE=$(echo "100 - $CPU_IDLE" | bc)
echo "CPU: ${CPU_USAGE}%"

# 内存使用
MEM_TOTAL=$(free | grep Mem | awk '{print $2}')
MEM_USED=$(free | grep Mem | awk '{print $3}')
MEM_PERCENT=$((MEM_USED * 100 / MEM_TOTAL))
echo "内存: ${MEM_PERCENT}%"

# 磁盘使用
DISK_USAGE=$(df -h . | awk 'NR==2 {print $5}' | cut -d'%' -f1)
echo "磁盘: ${DISK_USAGE}%"

if [ "${MEM_PERCENT}" -gt 90 ]; then
    echo "⚠️ 内存使用率过高（>${MEM_PERCENT}%）"
    echo "💡 可能导致502"
fi

if [ "${DISK_USAGE}" -gt 90 ]; then
    echo "⚠️ 磁盘使用率过高（>${DISK_USAGE}%）"
    echo "💡 可能导致502"
fi

echo ""

# 7. 诊断总结
echo "7️⃣ 诊断总结..."
echo "-------------------"

ISSUES_FOUND=0

# 检查关键问题
if ! pgrep -f "node.*index.js" > /dev/null; then
    echo "❌ 进程未运行 - 可能导致502"
    ((ISSUES_FOUND++))
fi

if ! netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
    echo "❌ 端口未监听 - 可能导致502"
    ((ISSUES_FOUND++))
fi

if ! curl -s -f "$HEALTH_URL" > /dev/null 2>&1; then
    echo "❌ 健康检查失败 - 可能导致502"
    ((ISSUES_FOUND++))
fi

if (( $(echo "$CPU_USAGE > 90" | bc -l) )); then
    echo "⚠️ CPU使用率过高 - 可能导致502"
    ((ISSUES_FOUND++))
fi

if [ "${MEM_PERCENT}" -gt 90 ]; then
    echo "⚠️ 内存使用率过高 - 可能导致502"
    ((ISSUES_FOUND++))
fi

if [ $ISSUES_FOUND -eq 0 ]; then
    echo "✅ 未发现明显的502原因"
    echo ""
    echo "💡 可能的原因："
    echo "   1. LB的健康检查配置不当"
    echo "   2. 实例启动时间太长"
    echo "   3. 网络延迟过高"
    echo "   4. LB的initial_delay太短"
else
    echo "⚠️ 发现 $ISSUES_FOUND 个可能导致502的问题"
fi

echo ""
echo "📋 下一步建议："
echo "1. 检查Axiom日志: ./query-axiom-logs.sh '502' 1h"
echo "2. 检查系统资源: top, htop"
echo "3. 查看应用日志: tail -f logs/app.log"
echo "4. 检查LB配置: 健康检查间隔、超时"
echo "5. 检查网络连接: ping, traceroute"

echo ""
echo "如需持续监控，可以运行:"
echo "./monitor-502.sh"