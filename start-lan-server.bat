@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   拼图定位台 - 局域网服务
echo   静态页面 + WebSocket 实时同步 + 数据落盘
echo   端口 8848
echo ============================================
echo.
echo 启动后，其他设备访问下面列出的局域网地址即可，
echo 进入同一张图就能实时同步。
echo 这个窗口请保持开着（关掉 = 停止服务）。
echo.

set NODE_EXE=C:\Users\乐幻\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node

"%NODE_EXE%" server.js 8848

echo.
echo 服务已停止。
pause
