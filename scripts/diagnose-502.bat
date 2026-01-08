@echo off
REM Windows版本的502错误诊断脚本
REM 使用方法: diagnose-502.bat [实例URL]

set INSTANCE_URL=%1
if "%INSTANCE_URL%"=="" set INSTANCE_URL=http://localhost:3000

echo 🔍 502错误诊断工具
echo ================================
echo 实例URL: %INSTANCE_URL%
echo.

REM 1. 检查进程状态
echo 1️⃣ 检查进程状态...
echo -------------------

tasklist /FI "IMAGENAME eq node.exe" /FO TABLE | find "node.exe" >nul
if %errorlevel% equ 0 (
    echo ✅ Node.js 进程运行中
    
    for /f "tokens=2" %%i in ('tasklist /FI "IMAGENAME eq node.exe" /FO CSV ^| find "index.js"') do (
        set PID=%%i
        echo    PID: %%i
    )
) else (
    echo ❌ Node.js 进程未运行
    echo    💡 可能是导致502的原因
)

echo.

REM 2. 检查端口监听
echo 2️⃣ 检查端口监听...
echo -------------------

for /f "tokens=3" %%i in ('netstat -ano ^| find ":3000 "') do (
    set PORT_PID=%%i
    goto port_found
)

:port_found
if defined PORT_PID (
    echo ✅ 端口 3000 正在监听
    echo    进程ID: %PORT_PID%
) else (
    echo ❌ 端口 3000 未监听
    echo    💡 可能是导致502的原因
)

echo.

REM 3. 检查健康检查
echo 3️⃣ 检查健康端点...
echo -------------------

set HEALTH_URL=%INSTANCE_URL%/health
set START_TIME=%TIME%

curl -s -f "%HEALTH_URL%" >nul 2>&1
if %errorlevel% equ 0 (
    set END_TIME=%TIME%
    echo ✅ 健康检查通过
    echo    响应时间: 快速
) else (
    echo ❌ 健康检查失败
    echo    💡 可能是导致502的原因
)

echo.

REM 4. 测试webhook端点
echo 4️⃣ 测试webhook端点...
echo -------------------

REM 测试下载webhook
set DOWNLOAD_WEBHOOK=%INSTANCE_URL%/api/tasks/download
curl -s -f -X POST "%DOWNLOAD_WEBHOOK%" -H "Content-Type: application/json" -d "{\"taskId\":\"test\"}" --max-time 5 >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ 下载webhook可访问
) else (
    echo ⚠️  下载webhook响应异常
    echo    退出码: %errorlevel%
    echo    💡 可能导致502
)

REM 测试上传webhook
set UPLOAD_WEBHOOK=%INSTANCE_URL%/api/tasks/upload
curl -s -f -X POST "%UPLOAD_WEBHOOK%" -H "Content-Type: application/json" -d "{\"taskId\":\"test\"}" --max-time 5 >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ 上传webhook可访问
) else (
    echo ⚠️  上传webhook响应异常
    echo    退出码: %errorlevel%
    echo    💡 可能导致502
)

echo.

REM 5. 检查最近错误
echo 5️⃣ 检查最近错误日志...
echo -------------------

if exist logs\app.log (
    echo 最近10个错误：
    findstr /i "error fatal crash" logs\app.log | more +0
    
    echo.
    echo 最近503错误（非Leader）：
    findstr /i "503 service unavailable" logs\app.log | more +0
) else (
    echo ⚠️  未找到日志文件 logs\app.log
)

echo.

REM 6. 检查系统资源
echo 6️⃣ 检查系统资源...
echo -------------------

REM CPU使用
for /f "tokens=2 delims=," %%i in ('typeperf "\Processor(_Total)\% Processor Time" -sc 1') do (
    set CPU_USAGE=%%i
)
set CPU_USAGE=%CPU_USAGE:~0,-2%
echo CPU: %CPU_USAGE%%%

if %CPU_USAGE% gtr 80 (
    echo ⚠️  CPU使用率过高（%CPU_USAGE%%%）
    echo 💡 可能导致502
)

echo.

REM 内存使用
for /f "tokens=2" %%i in ('systeminfo ^| find "Available Physical Memory"') do (
    set MEM_AVAIL=%%i
)

set MEM_AVAIL=%MEM_AVAIL: =0%
echo 可用内存: %MEM_AVAIL% MB

echo.

REM 7. 诊断总结
echo 7️⃣ 诊断总结...
echo -------------------

set ISSUES_FOUND=0

if not defined PID (
    echo ❌ 进程未运行 - 可能导致502
    set /a ISSUES_FOUND+=1
)

if not defined PORT_PID (
    echo ❌ 端口未监听 - 可能导致502
    set /a ISSUES_FOUND+=1
)

if %CPU_USAGE% gtr 90 (
    echo ⚠️  CPU使用率过高（%CPU_USAGE%%%）- 可能导致502
    set /a ISSUES_FOUND+=1
)

if %MEM_AVAIL% lss 512 (
    echo ⚠️  可用内存过低（%MEM_AVAIL%MB）- 可能导致502
    set /a ISSUES_FOUND+=1
)

if %ISSUES_FOUND% equ 0 (
    echo ✅ 未发现明显的502原因
    echo.
    echo 💡 可能的原因：
    echo    1. LB的健康检查配置不当
    echo    2. 实例启动时间太长
    echo    3. 网络延迟过高
    echo    4. LB的initial_delay太短
) else (
    echo ⚠️  发现 %ISSUES_FOUND% 个可能导致502的问题
)

echo.

echo 📋 下一步建议：
echo 1. 检查Axiom日志: query-axiom-logs.bat "502" 1h
echo 2. 检查系统资源: taskmgr
echo 3. 查看应用日志: type logs\app.log
echo 4. 检查LB配置: 健康检查间隔、超时
echo 5. 检查网络连接: ping 实例IP

echo.

echo 如需持续监控，可以运行:
echo monitor-502.bat

pause