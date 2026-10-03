@echo off
rem Beth Studio debug launcher: verbose host log, this checkout only.
setlocal
set WEZTERM_LOG=debug
set BETHTERM_ACTIVE=1
cd /d "%~dp0bethterm-web"
start "" "%CD%\bethterm-web.exe"
