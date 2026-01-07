#!/bin/bash

# 502错误持续监控脚本
# 使用方法: ./monitor-502.sh

echo "🔍 502错误持续监控中..."
echo "按 Ctrl+C 停止监控"
echo ""

# 监控配置
CHECK_INTERVAL=60  # 检查间隔（秒）
ALERT_THRESHOLD=5  # 触发告警的连续失败次数
CONSECUTIVE_FAILURES=0

# 保存上次检查时间
LAST_CHECK_TIME=$(date +%s)

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - LAST_CHECK_TIME))
    
    # 等待到下一个检查时间
    if [ $ELAPSED -lt $CHECK_INTERVAL ]; then
        sleep 1
        continue
    fi
    
    LAST_CHECK_TIME=$CURRENT_TIME
    
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 执行502检查..."
    
    # 1. 检查实例进程
    if ! pgrep -f "node.*index.js" > /dev/null; then
        echo "❌ 实例进程未运行"
        ((CONSECUTIVE_FAILURES++))
        echo "    连续失败次数: $CONSECUTIVE_FAILURES"
        
        if [ $CONSECUTIVE_FAILURES -ge $ALERT_THRESHOLD ]; then
            echo "🚨 告警: 连续 $CONSECUTIVE_FAILURES 次检查失败！"
            # 这里可以添加告警通知（邮件、Telegram等）
        fi
        
        sleep $CHECK_INTERVAL
        continue
    fi
    
    # 2. 检查健康检查
    if ! curl -s -f http://localhost:3000/health > /dev/null 2>&1; then
        echo "❌ 健康检查失败"
        ((CONSECUTIVE_FAILURES++))
        echo "    连续失败次数: $CONSECUTIVE_FAILURES"
        
        if [ $CONSECUTIVE_FAILURES -ge $ALERT_THRESHOLD ]; then
            echo "🚨 告警: 连续 $CONSECUTIVE_FAILURES 次检查失败！"
        fi
        
        sleep $CHECK_INTERVAL
        continue
    fi
    
    # 3. 检查资源使用
    CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
    MEM_USAGE=$(free | grep Mem | awk '{printf("%.0f", $3/$2 * 100.0)}')
    
    if (( $(echo "$CPU_USAGE > 90" | bc -l) )); then
        echo "⚠️  CPU使用率过高: ${CPU_USAGE}%"
    fi
    
    if [ "$MEM_USAGE" -gt 90 ]; then
        echo "⚠️  内存使用率过高: ${MEM_USAGE}%"
    fi
    
    # 4. 查询Axiom日志中的502
    COUNT=$(axiom query '_app="drive-collector" AND "502"' --since 1m --count 2>/dev/null || echo "0")
    if [ "$COUNT" -gt 0 ]; then
        echo "📊 最近1分钟内发现 $COUNT 个502错误"
        
        # 显示最近的502日志
        echo "    最近的502日志："
        axiom query '_app="drive-collector" AND "502"' --since 1m --format="json" \
            | jq -r '. | "\(.["@timestamp"]) \(.msg)"' | head -3
    fi
    
    # 5. 重置连续失败计数
    if [ $CONSECUTIVE_FAILURES -gt 0 ]; then
        echo "✅ 检查恢复正常"
        CONSECUTIVE_FAILURES=0
    fi
    
    echo "✅ 检查完成，等待下次检查..."
    echo ""
    
    sleep $CHECK_INTERVAL
done