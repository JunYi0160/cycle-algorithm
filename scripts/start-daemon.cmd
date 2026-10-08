@echo off
setlocal
cd /d "%~dp0\.."

if "%~1"=="autostart" set NO_OPEN=1
if "%~1"=="/autostart" set NO_OPEN=1
if "%~1"=="--autostart" set NO_OPEN=1

set ELECTRON_RUN_AS_NODE=1
set "PATH=%APPDATA%\Antigravity\bin;%LOCALAPPDATA%\agy\bin;%PATH%"

if not exist "scripts\.cache" mkdir "scripts\.cache"
echo [%date% %time%] Daemon starting, args: %* >> scripts\.cache\daemon.log

:: Check if port 8789 is already listening
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port 8789 -InformationLevel Quiet -WarningAction SilentlyContinue) { if ($env:NO_OPEN -ne '1') { Start-Process 'http://127.0.0.1:8789/cycle-algorithm/' }; exit 0 } else { exit 1 }"
if %ERRORLEVEL% EQU 0 (
  echo [%date% %time%] Port 8789 already in use, exiting. >> scripts\.cache\daemon.log
  exit /b 0
)

:: Ensure dist exists
if not exist "dist\index.html" (
  call node scripts/build.mjs >> scripts\.cache\daemon.log 2>&1
)

:: Start helper process
echo [%date% %time%] Starting helper.mjs... >> scripts\.cache\daemon.log
call node scripts/helper.mjs >> scripts\.cache\daemon.log 2>&1
