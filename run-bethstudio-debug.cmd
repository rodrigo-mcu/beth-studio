@echo off
rem Beth Studio debug launcher: verbose host log, this checkout only.
setlocal
set WEZTERM_LOG=debug
set BETHSTUDIO_ACTIVE=1
cd /d "%~dp0bethstudio-web"
start "" "%CD%\bethstudio-web.exe"
