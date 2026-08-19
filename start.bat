@echo off
setlocal

REM Check if bun is available
where bun >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Bun is not installed. Install from: https://bun.sh
    pause
    exit /b 1
)

cd /d "%~dp0"

REM Install deps if needed
if not exist node_modules (
    echo Installing dependencies...
    bun install
)

REM Launch the Electron app
bun start

pause
endlocal
