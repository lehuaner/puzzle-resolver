@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   拼图定位台 - 局域网服务
echo   Vite + Express + ws 统一框架
echo   端口 8848
echo ============================================
echo.
echo 启动后，其他设备访问下面列出的局域网地址即可，
echo 进入同一张图就能实时同步。
echo 这个窗口请保持开着（关掉 = 停止服务）。
echo.

set NODE_EXE=C:\Users\乐幻\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node
set NPM_CLI=C:\Users\乐幻\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\npm\bin\npm-cli.js

rem ---- 首次运行先构建前端；已有 dist/ 则直接启动 ----
if not exist dist\index.html (
  echo [首次运行] 正在构建前端...
  if exist "%NPM_CLI%" (
    "%NODE_EXE%" "%NPM_CLI%" run build
  ) else (
    call npm run build
  )
  if errorlevel 1 (
    echo.
    echo 构建失败，请检查上面的错误信息。
    pause
    exit /b 1
  )
)

"%NODE_EXE%" server\index.js --prod

echo.
echo 服务已停止。
pause
