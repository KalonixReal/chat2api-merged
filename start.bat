@echo off
setlocal

REM Check if bun is available
where bun >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] Bun is not installed.
    echo.
    echo Install it from: https://bun.sh
    echo.
    echo Or via PowerShell:
    echo   powershell -c "irm bun.sh/install.ps1 ^| iex"
    echo.
    echo If you just installed Bun, close this window and open a new one.
    echo.
    pause
    exit /b 1
)

REM Check if Python is available
python --version >nul 2>nul
if errorlevel 1 (
    python3 --version >nul 2>nul
    if errorlevel 1 (
        echo.
        echo [ERROR] Python 3.9+ is not installed.
        echo Install it from: https://python.org
        echo Do NOT use the Windows Store version.
        echo.
        pause
        exit /b 1
    )
)

cd /d "%~dp0"
bun run.ts server
pause
endlocal
