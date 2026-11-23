@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0install-pero.ps1" (
  echo Missing install-pero.ps1. Extract the complete Pero ZIP first.
  pause
  exit /b 1
)
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo Windows PowerShell is required.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-pero.ps1" -ExtensionDir "%~dp0"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Setup did not finish. See the message above.
pause
exit /b %RESULT%
