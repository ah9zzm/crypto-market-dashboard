@echo off
setlocal

cd /d "%~dp0"
title crypto-market-dashboard stop

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$repo = (Resolve-Path '.').Path; " ^
  "$proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " ^
  "Where-Object { $_.Name -match 'node(.exe)?$' -and $_.CommandLine -like '*scripts\\dev-all.mjs*' -and $_.CommandLine -like ('*' + $repo + '*') } | " ^
  "Select-Object -First 1; " ^
  "if (-not $proc) { exit 2 }; " ^
  "Stop-Process -Id $proc.ProcessId -Force"

set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo 개발 서버 중지 요청을 보냈습니다.
  exit /b 0
)

if "%EXIT_CODE%"=="2" (
  echo 실행 중인 통합 개발 서버를 찾지 못했습니다.
  pause
  exit /b 0
)

echo [ERROR] 개발 서버를 중지하지 못했습니다.
pause
exit /b %EXIT_CODE%
