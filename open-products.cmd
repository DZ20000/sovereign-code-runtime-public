@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1
node scripts\products.mjs --open
set "result=%errorlevel%"
if errorlevel 1 pause
popd
exit /b %result%
