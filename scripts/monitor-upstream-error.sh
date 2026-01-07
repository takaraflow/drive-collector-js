#!/bin/bash

# upstream connect error 持续监控脚本
# 使用方法: ./monitor-upstream-error.sh

INSTANCE_IP=${1:-"127.0.0.1"}
PORT=${2:-3000}
CHECK_INTERVAL=30  # 检查间隔（秒）

echo "🔍 持续监控 upstream connect error"
echo "=================================="
echo "实例: $INSTANCE_IP:$PORT"
echo "检查间隔: ${CHECK_INTERVAL}秒"
echo "按 Ctrl+C 停止监控"
echo ""

# 统计计数器
TOTAL_CHECKS=0
SUCCESS_COUNT=0
FAILED_COUNT=0
CONSECUTIVE_FAILURES=0
MAX_CONSECUTIVE_FAILURES=0

# 记录失败时间
FAILURE_TIMES=()

while true; do
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    
    echo "[$TIMESTAMP] 执行第 $TOTAL_CHECKS 次检查..."
    
    # 1. 检查进程
    if ! pgrep -f "node.*index.js" > /dev/null; then
        echo "  ❌ 进程未运行"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        FAILURE_TIMES+=("$TIMESTAMP - Process down")
        
        if [ $CONSECUTIVE_FAILURES -gt $MAX_CONSECUTIVE_FAILURES ]; then
            MAX_CONSECUTIVE_FAILURES=$CONSECUTIVE_FAILURES
        fi
        
        # 触发告警
        if [ $CONSECUTIVE_FAILURES -ge 3 ]; then
            echo "  🚨 警告: 进程已连续 $CONSECUTIVE_FAILURES 次检查失败"
            # 这里可以添加告警通知
        fi
    else
        echo "  ✅ 进程运行中"
        CONSECUTIVE_FAILURES=0
    fi
    
    # 2. 检查端口
    if ! netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
        echo "  ❌ 端口 $PORT 未监听"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        FAILURE_TIMES+=("$TIMESTAMP - Port not listening")
        
        if [ $CONSECUTIVE_FAILURES -gt $MAX_CONSECUTIVE_FAILURES ]; then
            MAX_CONSECUTIVE_FAILURES=$CONSECUTIVE_FAILURES
        fi
        
        if [ $CONSECUTIVE_FAILURES -ge 3 ]; then
            echo "  🚨 警告: 端口已连续 $CONSECUTIVE_FAILURES 次检查失败"
        fi
    else
        echo "  ✅ 端口 $PORT 正在监听"
        if [ $CONSECUTIVE_FAILURES -gt 0 ]; then
            CONSECUTIVE_FAILURES=0
        fi
    fi
    
    # 3. 健康检查
    if curl -s -f --max-time 3 "http://$INSTANCE_IP:$PORT/health" > /dev/null 2>&1; then
        echo "  ✅ 健康检查通过"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        CONSECUTIVE_FAILURES=0
    else
        echo "  ❌ 健康检查失败"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        FAILURE_TIMES+=("$TIMESTAMP - Health check failed")
        
        if [ $CONSECUTIVE_FAILURES -gt $MAX_CONSECUTIVE_FAILURES ]; then
            MAX_CONSECUTIVE_FAILURES=$CONSECUTIVE_FAILURES
        fi
        
        if [ $CONSECUTIVE_FAILURES -ge 3 ]; then
            echo "  🚨 警告: 健康检查已连续 $CONSECUTIVE_FAILURES 次失败"
        fi
    fi
    
    # 4. 检查资源使用
    CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
    MEM_USAGE=$(free | grep Mem | awk '{printf("%.0f", $3/$2 * 100.0)}')
    OPEN_FDS=$(ls -l /proc/*/fd 2>/dev/null | wc -l)
    
    echo "  📊 资源: CPU ${CPU_USAGE}% | 内存 ${MEM_USAGE}% | FD ${OPEN_FDS}"
    
    if (( $(echo "$CPU_USAGE > 90" | bc -l) )); then
        echo "    ⚠️  CPU使用率过高"
        FAILURE_TIMES+=("$TIMESTAMP - CPU high")
    fi
    
    if [ "$MEM_USAGE" -gt 90 ]; then
        echo "    ⚠️  内存使用率过高"
        FAILURE_TIMES+=("$TIMESTAMP - Memory high")
    fi
    
    if [ "$OPEN_FDS" -gt 1000 ]; then
        echo "    ⚠️  文件描述符过多"
        FAILURE_TIMES+=("$TIMESTAMP - Too many FDs")
    fi
    
    # 5. 统计信息
    SUCCESS_RATE=$((SUCCESS_COUNT * 100 / TOTAL_CHECKS))
    echo "  📈 统计: 成功率 ${SUCCESS_RATE}% | 总检查 $TOTAL_CHECKS | 失败 $FAILED_COUNT"
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # 6. 最近失败记录
    if [ ${#FAILURE_TIMES[@]} -gt 0 ]; then
        echo "📋 最近10次失败:"
        for failure in "${FAILURE_TIMES[@]: -10}"; do
            echo "   - $failure"
        done
        echo ""
    fi
    
    # 7. Axiom日志查询
    if [ $CONSECUTIVE_FAILURES -ge 2 ]; then
        echo "📊 查询Axiom日志..."
        
        AXIOM_COUNT=$(axiom query '_app="drive-collector" AND "upstream connect error"' --since 1m --count 2>/dev/null || echo "0")
        
        if [ "$AXIOM_COUNT" -gt 0 ]; then
            echo "  🔴 最近1分钟内发现 $AXIOM_COUNT 条upstream connect error日志"
            
            # 显示最近的错误日志
            echo "  最近错误日志:"
            axiom query '_app="drive-collector" AND "upstream connect error"' --since 1m --format="json" \
                | jq -r '. | "\(.["@timestamp"]) \(.msg)"' | head -5 | while read line; do
                    echo "     - $line"
                  done
        else
            echo "  ✅ Axiom中未发现最近的upstream connect error"
        fi
        
        echo ""
    fi
    
    # 等待下一次检查
    sleep $CHECK_INTERVAL
done