@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer and try again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

node helper\start-local-player.js
if errorlevel 1 (
  echo.
  echo The local player could not be started. Check the message above.
  pause
  exit /b 1
)

endlocal
