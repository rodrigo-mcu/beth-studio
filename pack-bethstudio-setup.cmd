@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack-bethstudio-setup.ps1" %*
exit /b %ERRORLEVEL%
