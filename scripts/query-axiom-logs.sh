#!/bin/bash

# Axiom 日志查询脚本
# 使用方法: ./query-axiom-logs.sh [关键词] [时间范围]

KEYWORD=${1:-"webhook"}  # 默认搜索 webhook
TIME_RANGE=${2:-"1h"}      # 默认最近1小时

echo "🔍 查询 Axiom 日志..."
echo "关键词: $KEYWORD"
echo "时间范围: $TIME_RANGE"
echo "================================"

# 安装 axiom CLI（如果没有）
if ! command -v axiom &> /dev/null; then
    echo "📦 安装 Axiom CLI..."
    curl -sSf https://sh.axiom.com/install | sh
    export PATH="$PATH:$HOME/.axiom/bin"
fi

# 检查是否已登录
if ! axiom whoami &> /dev/null; then
    echo "🔐 请先登录 Axiom:"
    echo "axiom login <your-token>"
    exit 1
fi

# 查询日志
echo "📊 查询结果:"
echo ""

# 查询不同来源的日志
echo "=== 🎯 QStash 直接发布的任务 ==="
axiom query "_app=\"drive-collector\" AND $KEYWORD AND \"direct-qstash\"" \
    --since "$TIME_RANGE" \
    --format="json" \
    | jq -r '."@timestamp" as $time | "\($time | strftime("%Y-%m-%d %H:%M:%S")) \(.msg)"' 2>/dev/null || \
    axiom query "_app=\"drive-collector\" AND $KEYWORD AND \"direct-qstash\"" --since "$TIME_RANGE"

echo ""
echo "=== 🌐 LB 转发的请求 ==="
axiom query "_app=\"drive-collector\" AND $KEYWORD AND NOT \"direct-qstash\"" \
    --since "$TIME_RANGE" \
    --format="json" \
    | jq -r '."@timestamp" as $time | "\($time | strftime("%Y-%m-%d %H:%M:%S")) \(.msg)"' 2>/dev/null || \
    axiom query "_app=\"drive-collector\" AND $KEYWORD AND NOT \"direct-qstash\"" --since "$TIME_RANGE"

echo ""
echo "=== 📊 触发源统计 ==="
echo "直接 QStash 发送:"
axiom query "_app=\"drive-collector\" AND \"isFromQStash:true\"" --since "$TIME_RANGE" --count
echo "其他来源:"
axiom query "_app=\"drive-collector\" AND \"isFromQStash:false\"" --since "$TIME_RANGE" --count

echo ""
echo "=== 🏠 实例分布 ==="
axiom query "_app=\"drive-collector\" AND instanceId" --since "$TIME_RANGE" \
    | jq -r '.instanceId' | sort | uniq -c | sort -nr

echo ""
echo "=== 🎯 最近10个任务详情 ==="
axiom query "_app=\"drive-collector\" AND (taskId OR triggerSource)" --since "$TIME_RANGE" \
    --format="json" \
    | jq -r 'select(.taskId) | "\(.["@timestamp"] | strftime("%H:%M:%S")) 任务:\(.taskId) 来源:\(.triggerSource // "unknown") 实例:\(.instanceId // "unknown")"' \
    | head -10

echo ""
echo "💡 提示:"
echo "- 使用 './query-axiom-logs.sh \"download webhook\" 2h' 查看下载日志"
echo "- 使用 './query-axiom-logs.sh \"upload webhook\" 30m' 查看上传日志"
echo "- 使用 './query-axiom-logs.sh \"ERROR\" 24h' 查看错误日志"