@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Puzzle Map - LAN Server (port 8848)
echo ============================================
echo.
echo Keep this window open. Closing it stops the server.
echo Other devices: open one of the LAN addresses printed
echo below, then join the same board to sync in real time.
echo.

set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "NPM_CLI=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node_modules\npm\bin\npm-cli.js"

rem ---- build frontend on first run; start directly if dist/ exists ----
if not exist dist\index.html (
  echo [first run] building frontend...
  if exist "%NPM_CLI%" (
    "%NODE_EXE%" "%NPM_CLI%" run build
  ) else (
    call npm run build
  )
  if errorlevel 1 (
    echo.
    echo Build FAILED. Check the errors above.
    pause
    exit /b 1
  )
)

"%NODE_EXE%" server\index.js --prod

echo.
echo Server stopped.
pause
