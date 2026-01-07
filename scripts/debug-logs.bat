@echo off
REM Windows版本的日志调试脚本
REM 使用方法: debug-logs.bat

echo 🔍 开始调试日志监控...

REM 检查Node.js进程
tasklist /FI "IMAGENAME eq node.exe" | find "node.exe" >nul
if %errorlevel% equ 0 (
    echo ✅ 发现运行中的Node.js进程
    echo 📊 实时日志输出 (Ctrl+C 退出):
    echo ================================
    
    REM 尝试查看日志文件
    if exist logs\app.log (
        type logs\app.log | findstr /C:"TaskManager" /C:"Dispatcher" /C:"MessageHandler" /C:"ERROR" /C:"WARN" /C:"🚀" /C:"📥" /C:"🔄" /C:"✅" /C:"❌"
    ) else (
        echo ⚠️ 未找到日志文件，尝试直接查看进程输出...
    )
) else (
    echo ❌ 未发现运行中的Node.js进程
    echo 💡 请先启动应用: npm start
)

pause