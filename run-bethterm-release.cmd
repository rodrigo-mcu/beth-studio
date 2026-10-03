@echo off
rem Daily BethTerm launch: release GUI, no CLI arguments.
rem Reuses the running GPU process (patch 0108 / 0115).
setlocal
set BETHTERM_ACTIVE=1
set WTINATOR_ACTIVE=1
cd /d "%~dp0upstream-wezterm\target\release"
if exist "%CD%\bethterm-gui.exe" (
  start "" "%CD%\bethterm-gui.exe"
) else if exist "%CD%\bethterm.exe" (
  start "" "%CD%\bethterm.exe"
) else (
  echo BethTerm release build not found. Run:
  echo   cargo +nightly build --release -p wezterm -p wezterm-gui
  exit /b 1
)
