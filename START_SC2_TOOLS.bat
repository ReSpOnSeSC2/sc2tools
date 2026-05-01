@echo off
title SC2 Tools Launcher
setlocal

echo.
echo  ====================================================
echo   SC2 Tools (Merged Toolkit) -- starting components...
echo  ====================================================
echo.

REM Project layout:
REM   TOOLS_ROOT  = repo root on the user's box (Stage 0 hard rule).
REM   ROOT        = reveal-sc2-opponent-main (overlay backend + watchers).
set "TOOLS_ROOT=C:\SC2TOOLS"
set "ROOT=%TOOLS_ROOT%\reveal-sc2-opponent-main"
cd /d "%ROOT%"

REM -- 1. SC2 Tools Launcher (Python) -----------------------------
REM    Stage 3 replaced the legacy Tkinter analyzer GUI with a thin
REM    launcher that:
REM      - spawns `npm start` for the Express backend,
REM      - polls /api/health until the server is ready,
REM      - opens http://127.0.0.1:3000/analyzer/ in the default browser.
REM    Closing this window stops the backend cleanly.
echo [1/3] Starting SC2 Tools Launcher (backend + Web Analyzer)...
start "SC2 -- Launcher" /D "%TOOLS_ROOT%\SC2Replay-Analyzer" cmd /k py SC2ReplayAnalyzer.py

REM    Give the backend a moment to bind before dependents (watchers,
REM    pollers) start posting to /api/replay etc.
echo       Waiting 3 seconds for backend to initialize...
timeout /t 3 /nobreak >nul

REM -- 2. Replay Watcher (Python, watchers/replay_watcher.py) ------
REM    Live + threaded deep parse, posts to /api/replay and /api/replay/deep,
REM    cross-writes data/MyOpponentHistory.json and data/meta_database.json.
echo [2/3] Starting Replay Watcher (live + deep)...
start "SC2 -- Replay Watcher" cmd /k "cd /d %ROOT% && python -m watchers.replay_watcher"

REM -- 3. API Poller (PowerShell) ----------------------------------
REM    Polls SC2's web API and writes opponent.txt, which the overlay
REM    backend watches for the "opponent detected" pop-up.
REM    Delegates to reveal-sc2-opponent.bat which is the single source
REM    of truth for SC2_CHARACTER_IDS / SC2_PLAYER_NAME / ACTIVE_REGIONS.
echo [3/3] Starting API Poller...
start "SC2 -- API Poller" cmd /k "cd /d %ROOT% && reveal-sc2-opponent.bat"

echo.
echo  All components launched. This window will close in 3 seconds.
echo  Tip: close any panel window to stop just that component.
echo  The Web Analyzer opens automatically once the backend is ready.
echo.
timeout /t 3 /nobreak >nul

endlocal
