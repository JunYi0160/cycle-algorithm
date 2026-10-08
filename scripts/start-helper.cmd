@echo off
setlocal
cd /d "%~dp0\.."

if "%~1"=="autostart" set NO_OPEN=1
if "%~1"=="/autostart" set NO_OPEN=1

set ELECTRON_RUN_AS_NODE=1
set "PATH=%APPDATA%\Antigravity\bin;%LOCALAPPDATA%\agy\bin;%PATH%"

if not exist "dist\index.html" (
  call node scripts/build.mjs
)

if not exist "%~dp0\.cache" mkdir "%~dp0\.cache"
echo [%date% %time%] start-helper.cmd running, args: %* >> "%~dp0\.cache\helper.log"
call node scripts/helper.mjs >> "%~dp0\.cache\helper.log" 2>&1
