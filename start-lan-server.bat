@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ---- if port 8848 is already in use, stop that process first ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8848" ^| findstr "LISTENING"') do (
  echo Port 8848 busy ^(PID %%a^) - stopping old process...
  taskkill /F /PID %%a >nul 2>&1
)

rem ---- wait until the port is really free (last run may still be releasing it;
rem      starting too early gives EADDRINUSE and the window closes at once) ----
set "_pw=0"
:waitfree
netstat -ano | findstr ":8848" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto portok
set /a _pw+=1
if %_pw% geq 25 goto portok
ping -n 2 -w 200 127.0.0.1 >nul
goto waitfree
:portok

echo ============================================
echo   Puzzle Map - LAN Server (port 8848)
echo ============================================
echo.
echo Keep this window open. Closing it stops the server.
echo Other devices: open one of the LAN addresses printed
echo below, then join the same board to sync in real time.
echo.
echo PP-OCR (high precision OCR) is started automatically
echo by this script and proxied at /ocrsvc - no second
echo window needed. First start needs ~15s to load models.
echo If it is already running on port 8849, it is reused.
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
