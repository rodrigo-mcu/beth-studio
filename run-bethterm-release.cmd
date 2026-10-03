@echo off
rem Daily Beth Studio launch: the Studio supervises bethterm-host and shows the terminals.
setlocal
set BETHTERM_ACTIVE=1
cd /d "%~dp0bethterm-web"
if exist "%CD%\bethterm-web.exe" (
  start "" "%CD%\bethterm-web.exe"
) else (
  echo Beth Studio build not found. Run:
  echo   powershell -File bethterm-web\build.ps1
  exit /b 1
)
