@echo off
setlocal

cd /d "%~dp0"
title crypto-market-dashboard dev

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd 를 찾을 수 없습니다. Node.js / npm 이 설치되어 있는지 확인해주세요.
  pause
  exit /b 1
)

call npm.cmd run dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] 개발 서버가 비정상 종료되었습니다. 위 로그를 확인해주세요.
  pause
)

exit /b %EXIT_CODE%
