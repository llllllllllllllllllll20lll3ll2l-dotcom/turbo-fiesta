@echo off
if not exist "%~dp0extension\install-pero.bat" (
  echo Missing extension\install-pero.bat. Download and extract the complete Pero ZIP.
  pause
  exit /b 1
)
call "%~dp0extension\install-pero.bat"
exit /b %ERRORLEVEL%
