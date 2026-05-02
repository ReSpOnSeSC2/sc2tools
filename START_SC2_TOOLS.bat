@echo off
title SC2 Tools Launcher
setlocal

REM Use the Windows ``py`` launcher consistently across every panel so
REM whichever Python is registered on PATH (or pinned via py.ini) wins.
REM Earlier versions mixed ``py`` and ``python``; whichever variant
REM wasn't on PATH made the corresponding window error out immediately.
set "PYTHON=py"

echo.
echo  ====================================================
echo   SC2 Tools (Merged Toolkit) -- starting components...
echo  ====================================================
echo.

REM Project layout:
REM   TOOLS_ROOT  = repo root on the user's box (Stage 0 hard rule).
REM   ROOT        = reveal-sc2-opponent-main (overlay backend + watchers).
REM Derive TOOLS_ROOT from the launcher's own location so installs on
REM non-default drives (E:\response\sc2tools, D:\Games\..., etc.) work
REM without editing this file. %~dp0 ends with a trailing backslash; we
REM strip it so %TOOLS_ROOT%\subdir composes correctly.
set "TOOLS_ROOT=%~dp0"
if "%TOOLS_ROOT:~-1%"=="\" set "TOOLS_ROOT=%TOOLS_ROOT:~0,-1%"
set "ROOT=%TOOLS_ROOT%\reveal-sc2-opponent-main"
if not exist "%ROOT%" (
    echo ERROR: reveal-sc2-opponent-main not found under "%TOOLS_ROOT%".
    echo Expected: "%ROOT%"
    echo Run START_SC2_TOOLS.bat from the repo root that contains the
    echo reveal-sc2-opponent-main folder.
    pause
    endlocal
    exit /b 1
)
cd /d "%ROOT%"

REM -- 1. Express overlay backend (Node) ----------------------------
REM    The merged backend serves /api/* and the SPA at /analyzer/.
REM    We launch ``npm start`` directly from stream-overlay-backend
REM    (no more dependency on the legacy SC2Replay-Analyzer Python
REM    launcher project, which doesn't exist on most installs).
echo [1/4] Starting Express overlay backend (stream-overlay-backend)...
start "SC2 -- Backend" /D "%ROOT%\stream-overlay-backend" cmd /k npm start

REM    Give the backend a moment to bind before dependents (watchers,
REM    pollers, GUI) start posting to /api/replay etc.
echo       Waiting 3 seconds for backend to initialize...
timeout /t 3 /nobreak >nul

REM -- 2. Analyzer GUI (Python, silent) -----------------------------
REM    Launches the customtkinter analyzer via ``pythonw`` so no extra
REM    console pops next to the watcher windows. All diagnostic output
REM    is redirected to data\analyzer.log by gui.run_gui itself.
echo [2/4] Starting Analyzer GUI (silent; logs to data\analyzer.log)...
start "" /D "%ROOT%" pythonw -m gui.run_gui

REM -- 3. Replay Watcher (Python, watchers/replay_watcher.py) ------
REM    Live + threaded deep parse, posts to /api/replay and /api/replay/deep,
REM    cross-writes data/MyOpponentHistory.json and data/meta_database.json.
echo [3/4] Starting Replay Watcher (live + deep)...
start "SC2 -- Replay Watcher" cmd /k "cd /d %ROOT% && %PYTHON% -m watchers.replay_watcher"

REM -- 4. API Poller (Python helper) -------------------------------
REM    Reads identity (Pulse character IDs, player name, regions) from
REM    data\config.json and runs the SC2Pulse poller. Calls
REM    poller_launch.py directly so we don't double-shell through
REM    reveal-sc2-opponent.bat.
echo [4/4] Starting API Poller...
start "SC2 -- API Poller" cmd /k "cd /d %ROOT% && %PYTHON% scripts\poller_launch.py"

echo.
echo  All components launched. This window will close in 3 seconds.
echo  Tip: close any panel window to stop just that component.
echo  The Web Analyzer opens automatically once the backend is ready.
echo.
timeout /t 3 /nobreak >nul

endlocal
