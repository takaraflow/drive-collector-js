#!/bin/bash

# upstream connect error 诊断脚本
# 使用方法: ./diagnose-upstream-error.sh [实例IP] [端口]

INSTANCE_IP=${1:-"127.0.0.1"}
PORT=${2:-3000}

echo "🔍 诊断 upstream connect error"
echo "============================"
echo "实例: $INSTANCE_IP:$PORT"
echo ""

# 1. 检查进程状态
echo "1️⃣ 检查进程状态..."
echo "-------------------"

if pgrep -f "node.*index.js" > /dev/null; then
    PID=$(pgrep -f "node.*index.js")
    echo "✅ Node.js 进程运行中 (PID: $PID)"
    
    # 检查启动时间
    START_TIME=$(ps -p $PID -o etime= | tr -d ' ')
    echo "   运行时间: $START_TIME"
    
    # 检查文件描述符
    FDS=$(ls -l /proc/$PID/fd 2>/dev/null | wc -l)
    echo "   打开文件数: $FDS"
    echo "   文件描述符限制: $(ulimit -n)"
    
    if [ $FDS -gt 1000 ]; then
        echo "   ⚠️ 文件描述符过多，可能导致连接问题"
    fi
    
    # 检查网络连接数
    NET_CONN=$(ss -tnp 2>/dev/null | grep ":$PORT " | wc -l)
    echo "   网络连接数: $NET_CONN"
    
    if [ $NET_CONN -gt 100 ]; then
        echo "   ⚠️ 连接数过多，可能导致连接重置"
    fi
else
    echo "❌ Node.js 进程未运行"
    echo "   💡 进程未运行是导致连接重置的常见原因"
    exit 1
fi

echo ""

# 2. 检查端口监听
echo "2️⃣ 检查端口监听..."
echo "-------------------"

if netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
    echo "✅ 端口 $PORT 正在监听"
    
    # 显示监听详情
    netstat -tuln 2>/dev/null | grep ":$PORT " | while read line; do
        echo "   $line"
    done
    
    # 检查是否绑定到正确的地址
    if netstat -tuln 2>/dev/null | grep ":$PORT " | grep -q "0.0.0.0"; then
        echo "   ✅ 监听所有接口"
    else
        echo "   ⚠️ 监听特定地址"
        echo "   💡 确保LB能访问此地址"
    fi
else
    echo "❌ 端口 $PORT 未监听"
    echo "   💡 端口未监听是导致连接重置的常见原因"
    exit 1
fi

echo ""

# 3. 测试健康检查
echo "3️⃣ 测试健康检查..."
echo "-------------------"

HEALTH_URL="http://$INSTANCE_IP:$PORT/health"
HEALTH_START=$(date +%s.%N)

if curl -s -f --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
    HEALTH_END=$(date +%s.%N)
    HEALTH_TIME=$(echo "$HEALTH_END - $HEALTH_START" | bc -l)
    echo "✅ 健康检查通过"
    echo "   响应时间: ${HEALTH_TIME}s"
    
    if (( $(echo "$HEALTH_TIME > 2" | bc -l) )); then
        echo "   ⚠️ 响应时间过长（>${HEALTH_TIME}s）"
        echo "   💡 响应时间过长可能导致LB超时和连接重置"
    fi
    
    # 测试多次以检查稳定性
    echo ""
    echo "   连续测试5次健康检查..."
    FAILED_COUNT=0
    
    for i in {1..5}; do
        if ! curl -s -f --max-time 3 "$HEALTH_URL" > /dev/null 2>&1; then
            FAILED_COUNT=$((FAILED_COUNT + 1))
            echo "     第${i}次: ❌ 失败"
        else
            echo "     第${i}次: ✅ 成功"
        fi
        
        sleep 0.5
    done
    
    if [ $FAILED_COUNT -gt 0 ]; then
        echo "   ⚠️ 健康检查不稳定（失败$FAILED_COUNT/5次）"
        echo "   💡 不稳定的服务会导致LB频繁遇到连接重置"
    fi
else
    echo "❌ 健康检查失败"
    echo "   💡 健康检查失败会导致LB判断实例不可用"
    exit 1
fi

echo ""

# 4. 测试网络连接
echo "4️⃣ 测试网络连接..."
echo "-------------------"

# 4.1 测试基本连通性
echo "基本连通性测试:"
PING_LOSS=$(ping -c 10 $INSTANCE_IP | grep "packet loss" | awk '{print $6}' | tr -d '%')
echo "   丢包率: ${PING_LOSS}%"

if (( $(echo "$PING_LOSS > 10" | bc -l) )); then
    echo "   ⚠️ 丢包率过高"
    echo "   💡 网络不稳定会导致连接重置"
fi

# 4.2 测试TCP连接
echo ""
echo "TCP连接测试:"
TIMEOUT_CMD="timeout 3 telnet $INSTANCE_IP $PORT 2>&1"

if $TIMEOUT_CMD | grep -q "Connected"; then
    echo "   ✅ TCP连接成功"
else
    echo "   ❌ TCP连接失败或超时"
    echo "   💡 TCP连接失败会导致upstream connect error"
fi

# 4.3 测试HTTP连接
echo ""
echo "HTTP连接测试:"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://$INSTANCE_IP:$PORT/health" 2>&1)

if [ "$HTTP_CODE" = "200" ]; then
    echo "   ✅ HTTP连接成功 (200 OK)"
else
    echo "   ⚠️ HTTP连接异常 (代码: $HTTP_CODE)"
    echo "   💡 HTTP连接异常会导致协议错误和连接重置"
fi

echo ""

# 5. 检查MTU和包分片
echo "5️⃣ 检查MTU配置..."
echo "-------------------"

# 检查接口MTU
INTERFACE=$(ip route get $INSTANCE_IP | grep -oP 'dev \K\S+')
if [ -n "$INTERFACE" ]; then
    MTU=$(ip link show $INTERFACE | grep -oP 'mtu \K\d+')
    echo "接口: $INTERFACE"
    echo "MTU: $MTU"
    
    if [ "$MTU" -lt 1400 ]; then
        echo "   ⚠️ MTU过小（<1400）"
        echo "   💡 小MTU可能导致包分片和连接重置"
    fi
fi

# 检查是否启用了PMTU发现
PMTU_FILE="/proc/sys/net/ipv4/no_pmtu_disc"
if [ -f "$PMTU_FILE" ]; then
    PMTU_STATUS=$(cat $PMTU_FILE)
    echo "PMTU Discovery: $PMTU_STATUS"
    
    if [ "$PMTU_STATUS" = "0" ]; then
        echo "   ⚠️ PMTU Discovery已启用"
        echo "   💡 在不稳定网络中，PMTU可能导致连接问题"
    fi
fi

echo ""

# 6. 检查系统资源
echo "6️⃣ 检查系统资源..."
echo "-------------------"

# CPU使用
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
echo "CPU使用率: ${CPU_USAGE}%"

if (( $(echo "$CPU_USAGE > 90" | bc -l) )); then
    echo "   ⚠️ CPU使用率过高"
    echo "   💡 CPU过高会导致响应慢，LB可能超时并重置连接"
fi

# 内存使用
MEM_USAGE=$(free | grep Mem | awk '{printf("%.0f", $3/$2 * 100.0)}')
echo "内存使用率: ${MEM_USAGE}%"

if [ "$MEM_USAGE" -gt 90 ]; then
    echo "   ⚠️ 内存使用率过高"
    echo "   💡 内存不足可能导致连接不稳定"
fi

# 文件描述符
OPEN_FDS=$(ls -l /proc/*/fd 2>/dev/null | wc -l)
FILE_MAX=$(cat /proc/sys/fs/file-max)
FD_PERCENT=$((OPEN_FDS * 100 / FILE_MAX))
echo "文件描述符: $OPEN_FDS / $FILE_MAX (${FD_PERCENT}%)"

if [ "$FD_PERCENT" -gt 80 ]; then
    echo "   ⚠️ 文件描述符使用率过高"
    echo "   💡 文件描述符不足可能导致新连接失败"
fi

echo ""

# 7. 检查TCP参数
echo "7️⃣ 检查TCP参数..."
echo "-------------------"

# 连接队列
SOMAXCONN=$(cat /proc/sys/net/core/somaxconn)
echo "连接队列(somaxconn): $SOMAXCONN"

if [ "$SOMAXCONN" -lt 128 ]; then
    echo "   ⚠️ 连接队列过小"
    echo "   💡 队列过小会导致连接被拒绝"
fi

# 最大连接数
SOMAXCONN=$(cat /proc/sys/net/core/netdev_max_backlog)
echo "最大连接数(netdev_max_backlog): $SOMAXCONN"

# TCP超时设置
FIN_TIMEOUT=$(cat /proc/sys/net/ipv4/tcp_fin_timeout)
KEEPALIVE_TIME=$(cat /proc/sys/net/ipv4/tcp_keepalive_time)
echo "TCP超时: fin_timeout=${FIN_TIMEOUT}s, keepalive_time=${KEEPALIVE_TIME}s"

echo ""

# 8. 测试连接稳定性
echo "8️⃣ 测试连接稳定性..."
echo "-------------------"

echo "进行20次连接测试..."
SUCCESS_COUNT=0
FAILED_COUNT=0

for i in {1..20}; do
    if curl -s -f --max-time 2 "http://$INSTANCE_IP:$PORT/health" > /dev/null 2>&1; then
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        echo -n "✓"
    else
        FAILED_COUNT=$((FAILED_COUNT + 1))
        echo -n "✗"
    fi
done

echo ""
echo "测试结果: 成功 $SUCCESS_COUNT 次，失败 $FAILED_COUNT 次"

SUCCESS_RATE=$((SUCCESS_COUNT * 100 / 20))
if [ "$SUCCESS_RATE" -lt 80 ]; then
    echo "⚠️ 连接成功率过低（${SUCCESS_RATE}%）"
    echo "   💡 连接不稳定会导致LB频繁遇到连接重置"
fi

echo ""

# 9. 检查防火墙
echo "9️⃣ 检查防火墙状态..."
echo "-------------------"

# 检查iptables规则
if command -v iptables &> /dev/null; then
    IPTABLES_COUNT=$(iptables -L INPUT -n 2>/dev/null | grep -c ":$PORT")
    echo "iptables规则数: $IPTABLES_COUNT"
    
    if [ "$IPTABLES_COUNT" -gt 0 ]; then
        echo "   ⚠️ 发现端口 $PORT 的防火墙规则"
        echo "   💡 检查防火墙规则是否正确"
    fi
fi

# 检查SELinux
if command -v getenforce &> /dev/null; then
    SELINUX_STATUS=$(getenforce)
    echo "SELinux状态: $SELINUX_STATUS"
    
    if [ "$SELINUX_STATUS" != "Disabled" ]; then
        echo "   ⚠️ SELinux已启用"
        echo "   💡 检查SELinux上下文是否正确"
    fi
fi

echo ""

# 10. 诊断总结
echo "🔬 诊断总结..."
echo "=================="

ISSUES_FOUND=0

# 检查关键问题
if ! pgrep -f "node.*index.js" > /dev/null; then
    echo "❌ 进程未运行 - 最可能的根本原因"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

if ! netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
    echo "❌ 端口未监听 - 最可能的根本原因"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

if [ "$FD_PERCENT" -gt 80 ]; then
    echo "⚠️ 文件描述符使用率过高"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

if [ "$SUCCESS_RATE" -lt 80 ]; then
    echo "⚠️ 连接成功率过低"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

if [ "$MEM_USAGE" -gt 90 ]; then
    echo "⚠️ 内存使用率过高"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

if [ "$CPU_USAGE" -gt 90 ]; then
    echo "⚠️ CPU使用率过高"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

echo ""
if [ $ISSUES_FOUND -eq 0 ]; then
    echo "✅ 未发现明显的upstream connect error原因"
    echo ""
    echo "💡 可能的原因："
    echo "   1. LB的超时配置过短"
    echo "   2. LB和实例之间的网络不稳定"
    echo "   3. 实例启动时间过长，LB过早发送请求"
    echo "   4. HTTP协议版本不匹配"
    echo "   5. MTU配置问题导致包分片"
    
    echo ""
    echo "🔧 建议检查LB配置："
    echo "   - 增加connect_timeout"
    echo "   - 增加proxy_read_timeout和proxy_send_timeout"
    echo "   - 配置initial_delay_seconds（如果实例启动慢）"
    echo "   - 检查proxy_buffer设置"
else
    echo "⚠️ 发现 $ISSUES_FOUND 个可能导致upstream connect error的问题"
fi

echo ""
echo "📋 下一步操作："
echo "1. 检查Axiom日志中的upstream connect error频率"
echo "2. 检查LB的nginx/error日志"
echo "3. 运行./monitor-connections.sh 持续监控连接状态"
echo "4. 根据诊断结果调整LB或系统配置"

echo ""
echo "🔗 相关文档："
echo "- UPSTREAM_RESET_ERROR_GUIDE.md - 完整的upstream connect error诊断指南"
echo "- 502_ERROR_GUIDE.md - 502错误的诊断指南"