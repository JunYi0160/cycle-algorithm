@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0\manage-autostart.ps1" -Action Enable
pause
