@echo off
setlocal
title Cycle Algorithm Local Helper
cd /d "%~dp0\.."
echo ===================================================
echo   Cycle Algorithm - Local Helper ^& Antigravity
echo ===================================================
echo.
set ELECTRON_RUN_AS_NODE=1
set "PATH=%APPDATA%\Antigravity\bin;%LOCALAPPDATA%\agy\bin;%PATH%"
node scripts/build.mjs
echo.
echo Starting Cycle Algorithm Local Helper...
node scripts/helper.mjs
pause
