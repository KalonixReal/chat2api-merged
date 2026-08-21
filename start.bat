@echo off
setlocal

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

REM Download Electron binary if missing (bun install skips this)
if not exist node_modules\electron\path.txt (
    echo Downloading Electron binary...
    bun node_modules\electron\install.js
)

REM Install Playwright Chromium if needed
if not exist "%USERPROFILE%\AppData\Local\ms-playwright\chromium*" (
    echo Installing Playwright Chromium...
    bunx playwright install chromium
)

REM Build and launch the Electron app
echo Building and starting Chat2API...
bun run build
bunx electron .

pause
endlocal
