@echo off
REM chat2api-merged — Windows double-click launcher
REM
REM Runs the web dashboard server (no Electron). After it boots, open
REM http://localhost:8080/dashboard in your browser.
REM
REM No PowerShell, no WSL, no git bash required.

setlocal

REM Check if bun is available
where bun >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] Bun is not installed.
    echo.
    echo Bun is the only prerequisite. Install it from:
    echo   https://bun.sh
    echo.
    echo Or via PowerShell:
    echo   powershell -c "irm bun.sh/install.ps1 ^| iex"
    echo.
    pause
    exit /b 1
)

REM Get the directory of this batch file
cd /d "%~dp0"

REM Run the web dashboard server (no Electron)
bun run.ts server

REM If something failed, keep the window open so the user can read the error
if errorlevel 1 (
    echo.
    echo [FAILED] Exit code %errorlevel%. See logs\ folder for details.
    pause
)

endlocal
