@echo off
REM chat2api-merged — Windows double-click launcher
REM
REM Just double-click this file. It will:
REM   1. Check bun is installed (if not, shows install instructions)
REM   2. Run bun run.ts (which auto-installs deps on first run, boots daemons,
REM      and launches the Electron app dashboard)
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

REM Run the Windows launcher
bun run.ts

REM If something failed, keep the window open so the user can read the error
if errorlevel 1 (
    echo.
    echo [FAILED] Exit code %errorlevel%. See logs\ folder for details.
    pause
)

endlocal
