@echo off
REM chat2api-merged — Windows double-click launcher
REM
REM Runs the web dashboard server. After it boots, open
REM http://localhost:8080/dashboard in your browser.
REM
REM Prerequisites: Bun (https://bun.sh) + Python 3.9+ (from python.org, NOT Store stub)
REM
REM No PowerShell, no WSL, no git bash required.

setlocal

REM Check if bun is available
where bun >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] Bun is not installed.
    echo.
    echo Bun is a prerequisite. Install it from:
    echo   https://bun.sh
    echo.
    echo Or via PowerShell:
    echo   powershell -c "irm bun.sh/install.ps1 ^| iex"
    echo.
    echo If you just installed Bun, close this window and open a new one
    echo (so the PATH refresh takes effect).
    echo.
    pause
    exit /b 1
)

REM Check if Python 3.x is available (NOT the Windows Store stub)
python --version >nul 2>nul
if errorlevel 1 (
    python3 --version >nul 2>nul
    if errorlevel 1 (
        echo.
        echo [ERROR] Python 3.9+ is not installed.
        echo.
        echo Python is a prerequisite (used by the DeepSeek daemon).
        echo Install it from: https://python.org
        echo.
        echo IMPORTANT: Do NOT use the Windows Store stub — it doesn't work.
        echo Download the installer from python.org and check "Add to PATH".
        echo.
        pause
        exit /b 1
    )
)

REM Get the directory of this batch file
cd /d "%~dp0"

REM Run the web dashboard server (no Electron)
bun run.ts server

REM Always pause so the user can read the output (even on success/Ctrl+C)
echo.
pause

endlocal
