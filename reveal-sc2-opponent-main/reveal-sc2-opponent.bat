@echo off
REM ============================================================
REM  reveal-sc2-opponent launcher (config-driven)
REM ------------------------------------------------------------
REM  Identity (Pulse character IDs, player name, active regions)
REM  is read from data\config.json -- the file the first-run
REM  wizard writes. To change it, re-run the wizard at
REM  http://127.0.0.1:3000/analyzer/ or edit data\config.json
REM  by hand. There are no hardcoded credentials here.
REM
REM  Most users do not need to invoke this .bat directly. The
REM  desktop launcher (SC2ReplayAnalyzer.py) spawns the same
REM  PowerShell poller automatically using the same Python
REM  helper. This script exists for power users who want to run
REM  the poller standalone (e.g., debugging without the backend).
REM ============================================================

setlocal
set "ROOT=%~dp0"
set "HELPER=%ROOT%scripts\poller_launch.py"

REM Use whichever Python is on PATH. The installed copy registers
REM ``python`` system-wide; if you use ``py`` instead, change this.
where python >nul 2>nul
if errorlevel 1 (
    echo ERROR: python not found on PATH.
    echo Install Python 3.12 or run via the desktop launcher.
    endlocal
    exit /b 1
)

python "%HELPER%"
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
