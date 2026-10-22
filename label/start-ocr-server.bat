@echo off
rem Puzzle label tool - RapidOCR service (port 8849)
rem Keep this file pure ASCII (cmd parsing breaks on UTF-8 Chinese).
title Puzzle Label OCR Server (port 8849)

rem ---- if port 8849 is already in use, stop that process first ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8849" ^| findstr "LISTENING"') do (
  echo Port 8849 busy ^(PID %%a^) - stopping old process...
  taskkill /F /PID %%a >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

echo Starting RapidOCR service for the puzzle label tool...
echo Keep this window open. Close it (or press Ctrl+C) to stop the service.
"%LOCALAPPDATA%\Programs\Python\Python313\python.exe" "%~dp0ocr_server.py"
echo.
echo Service exited. If there is an error above, check that Python and rapidocr are installed.
pause
