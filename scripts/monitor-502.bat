@echo off
REM Windows版本的502错误持续监控脚本
REM 使用方法: monitor-502.bat

echo 🔍 502错误持续监控中...
echo 按 Ctrl+C 停止监控
echo.

REM 监控配置
set /a CHECK_INTERVAL=60
set /a ALERT_THRESHOLD=5
set /a CONSECUTIVE_FAILURES=0

:monitor_loop
REM 等待检查间隔
timeout /t %CHECK_INTERVAL% /nobreak >nul

REM 检查时间
set TIMESTAMP=%date% %time%
echo [%TIMESTAMP%] 执行502检查...

REM 1. 检查实例进程
tasklist /FI "IMAGENAME eq node.exe" /FO CSV | find "node.exe" >nul
if %errorlevel% neq 0 (
    echo ❌ 实例进程未运行
    set /a CONSECUTIVE_FAILURES+=1
    echo     连续失败次数: %CONSECUTIVE_FAILURES%
    
    if %CONSECUTIVE_FAILURES% geq %ALERT_THRESHOLD% (
        echo 🚨 警告: 连续 %CONSECUTIVE_FAILURES% 次检查失败！
        REM 可以添加告警通知逻辑
    )
    
    goto monitor_loop
)

REM 2. 检查健康端点
curl -s -f http://localhost:3000/health >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 健康检查失败
    set /a CONSECUTIVE_FAILURES+=1
    echo     连续失败次数: %CONSECUTIVE_FAILURES%
    
    if %CONSECUTIVE_FAILURES% geq %ALERT_THRESHOLD% (
        echo 🚨 警告: 连续 %CONSECUTIVE_FAILURES% 次检查失败！
    )
    
    goto monitor_loop
)

REM 3. 检查系统资源
REM CPU使用率
for /f "tokens=2 delims=," %%i in ('typeperf "\Processor(_Total)\% Processor Time" -sc 1') do (
    set CPU_USAGE=%%i
)

set CPU_USAGE=%CPU_USAGE: =0,-2%
if %CPU_USAGE% gtr 90 (
    echo ⚠️  CPU使用率过高: %CPU_USAGE%%%
)

REM 可用内存
for /f "tokens=2 delims=," %%i in ('systeminfo ^| find "Available Physical Memory"') do (
    set MEM_AVAIL=%%i
)

set MEM_AVAIL=%MEM_AVAIL: =0%
if %MEM_AVAIL% lss 512 (
    echo ⚠️ 可用内存过低: %MEM_AVAIL% MB
)

REM 4. 检查网络连通性
ping -n 1 localhost >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 本地网络不可达
    set /a CONSECUTIVE_FAILURES+=1
)

REM 5. 查询Axiom日志中的502
set AXIOM_COUNT=0
for /f "delims=" %%i in ('axiom query "_app=^\"drive-collector^\" AND ^\"502^\"" --since 1m --count 2^>^&1') do (
    set AXIOM_COUNT=%%i
)

if %AXIOM_COUNT% gtr 0 (
    echo 📊 最近1分钟内发现 %AXIOM_COUNT% 个502错误
)

REM 6. 重置连续失败计数
if %CONSECUTIVE_FAILURES% gtr 0 (
    echo ✅ 检查恢复正常
    set CONSECUTIVE_FAILURES=0
)

echo.
echo ✅ 检查完成，等待下次检查...
echo.

goto monitor_loop