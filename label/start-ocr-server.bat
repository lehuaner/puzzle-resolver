@echo off
rem Puzzle label tool - RapidOCR service (port 8849)
rem Keep this file pure ASCII (cmd parsing breaks on UTF-8 Chinese).
title Puzzle Label OCR Server (port 8849)
echo Starting RapidOCR service for the puzzle label tool...
echo Keep this window open. Close it (or press Ctrl+C) to stop the service.
"%LOCALAPPDATA%\Programs\Python\Python313\python.exe" "%~dp0ocr_server.py"
echo.
echo Service exited. If there is an error above, check that Python and rapidocr are installed.
pause
