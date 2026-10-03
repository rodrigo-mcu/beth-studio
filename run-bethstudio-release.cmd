@echo off
rem Daily Beth Studio launch: the Studio supervises bethstudio-host and shows the terminals.
setlocal
set BETHSTUDIO_ACTIVE=1
cd /d "%~dp0bethstudio-web"
if exist "%CD%\bethstudio-web.exe" (
  start "" "%CD%\bethstudio-web.exe"
) else (
  echo Beth Studio build not found. Run:
  echo   powershell -File bethstudio-web\build.ps1
  exit /b 1
)
