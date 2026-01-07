@echo off
REM Windows版本的 Axiom 日志查询脚本
REM 使用方法: query-axiom-logs.bat [关键词] [时间范围]

set KEYWORD=%1
set TIME_RANGE=%2

if "%KEYWORD%"=="" set KEYWORD=webhook
if "%TIME_RANGE%"=="" set TIME_RANGE=1h

echo 🔍 查询 Axiom 日志...
echo 关键词: %KEYWORD%
echo 时间范围: %TIME_RANGE%
echo ================================

REM 检查是否安装了 axiom
where axiom >nul 2>&1
if %errorlevel% neq 0 (
    echo 📦 安装 Axiom CLI...
    curl -sSf https://sh.axiom.com/install | sh
    echo 请重启命令提示符后再运行此脚本
    pause
    exit /b 1
)

REM 检查是否已登录
axiom whoami >nul 2>&1
if %errorlevel% neq 0 (
    echo 🔐 请先登录 Axiom:
    echo axiom login ^<your-token^>
    pause
    exit /b 1
)

REM 查询不同来源的日志
echo.
echo === 🎯 QStash 直接发布的任务 ===
axiom query "_app=\"drive-collector\" AND %KEYWORD% AND \"direct-qstash\"" --since "%TIME_RANGE%"

echo.
echo === 🌐 LB 潬发的请求 ===
axiom query "_app=\"drive-collector\" AND %KEYWORD% AND NOT \"direct-qstash\"" --since "%TIME_RANGE%"

echo.
echo === 📊 触发源统计 ===
echo 直接 QStash 发送:
axiom query "_app=\"drive-collector\" AND \"isFromQStash:true\"" --since "%TIME_RANGE%" --count
echo 其他来源:
axiom query "_app=\"drive-collector\" AND \"isFromQStash:false\"" --since "%TIME_RANGE%" --count

echo.
echo === 🏠 实例分布 ===
axiom query "_app=\"drive-collector\" AND instanceId" --since "%TIME_RANGE%"

echo.
echo === 🎯 最近10个任务详情 ===
axiom query "_app=\"drive-collector\" AND (taskId OR triggerSource)" --since "%TIME_RANGE%" --format="json" | jq -r ". | select(.taskId) | \"任务:\(.taskId) 来源:\(.triggerSource // \"unknown\") 实例:\(.instanceId // \"unknown\")\""" | head -10

echo.
echo 💡 提示:
echo - 使用 query-axiom-logs.bat "download webhook" 2h 看下载日志
echo - 使用 query-axiom-logs.bat "upload webhook" 30m 看上传日志
echo - 使用 query-axiom-logs.bat "ERROR" 24h 看错误日志

pause