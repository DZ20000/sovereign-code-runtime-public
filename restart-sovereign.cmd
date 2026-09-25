@echo off
setlocal EnableExtensions
title Restart current Sovereign version
cd /d "%~dp0"

where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo pnpm.cmd was not found on PATH.
  echo Install pnpm or run this shortcut from the Sovereign development environment.
  pause
  exit /b 1
)

call pnpm.cmd restart
set "restart_exit=%ERRORLEVEL%"
if not "%restart_exit%"=="0" (
  echo.
  echo Sovereign restart failed with exit code %restart_exit%.
  pause
)
exit /b %restart_exit%
