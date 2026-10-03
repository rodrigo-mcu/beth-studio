@echo off
rem BethTerm debug launcher. Starts this checkout's bethterm.exe,
rem never the system-installed WezTerm.
setlocal
set WEZTERM_LOG=debug
set BETHTERM_ACTIVE=1
set WTINATOR_ACTIVE=1
cd /d "%~dp0upstream-wezterm\target\debug"
if exist "%CD%\bethterm.exe" (
  start "" "%CD%\bethterm.exe" start --always-new-process
) else (
  start "" "%CD%\wezterm.exe" start --always-new-process
)
