@echo off
title SC2 Tools Launcher
setlocal

echo.
echo  ====================================================
echo   SC2 Tools (Merged Toolkit) -- starting components...
echo  ====================================================
echo.

set "ROOT=C:\SC2TOOLS\reveal-sc2-opponent-main"
cd /d "%ROOT%"

REM -- 1. Overlay Server (Node.js) ---------------------------------
echo [1/5] Starting Overlay Server (Node)...
start "SC2 -- Overlay Server" cmd /k "cd /d %ROOT%\stream-overlay-backend && node index.js"

REM -- Give the server a moment to bind so dependents don't race it.
echo       Waiting 3 seconds for server to initialize...
timeout /t 3 /nobreak >nul

REM -- 2. Replay Watcher (Python, watchers/replay_watcher.py) ------
REM    Live + threaded deep parse, posts to /api/replay and /api/replay/deep,
REM    cross-writes data/MyOpponentHistory.json and data/meta_database.json.
echo [2/5] Starting Replay Watcher (live + deep)...
start "SC2 -- Replay Watcher" cmd /k "cd /d %ROOT% && python -m watchers.replay_watcher"

REM -- 3. MMR Scanner (Python + Tesseract) -------------------------
REM    Dual-zone OCR of the loading screen, writes scanned_mmr.txt.
echo [3/5] Starting MMR Scanner (OCR)...
start "SC2 -- MMR Scanner" cmd /k "cd /d %ROOT% && python -m watchers.sc2_mmr_scanner"

REM -- 4. API Poller (PowerShell) ----------------------------------
REM    Polls SC2's web API and writes opponent.txt, which the overlay
REM    backend watches for the "opponent detected" pop-up.
echo [4/5] Starting API Poller...
start "SC2 -- API Poller" powershell ^
 -NoExit ^
 -ExecutionPolicy bypass ^
 -Command "cd '%ROOT%'; .\Reveal-Sc2Opponent.ps1 -DisableQuickEdit -FilePath opponent.txt -RatingFormat long -RaceFormat short -Separator \`r\`n -Limit 1"

REM -- 5. Analyzer GUI (Python + customtkinter) -------------------
REM    Legacy analyzer GUI -- still launches alongside the new web UI
REM    so you can fall back to it. Reads/writes the same
REM    data/meta_database.json that the replay watcher cross-writes
REM    during games, so post-game stats update live.
REM    Uses pythonw.exe so the GUI does not also pop a console window.
echo [5/6 -- optional] Launching legacy Analyzer GUI...
start "" /D "%ROOT%" pythonw -m gui.run_gui

REM -- 6. Web Analyzer (browser SPA) -------------------------------
REM    The new analyzer UI is served by the overlay backend at
REM    http://localhost:3000/analyzer. Live updates over Socket.io,
REM    full feature set (per-opponent deep dives, time-series,
REM    global filters, CSV export). Open in default browser.
echo [6/6] Opening Web Analyzer in your default browser...
REM    Wait briefly so the backend is definitely listening.
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/analyzer"

echo.
echo  All components launched. This window will close in 3 seconds.
echo  Tip: close any panel window to stop just that component.
echo.
timeout /t 3 /nobreak >nul

endlocal
