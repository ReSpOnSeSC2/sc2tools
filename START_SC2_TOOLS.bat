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
REM This copy of the launcher lives INSIDE reveal-sc2-opponent-main, so
REM ROOT is the script's own directory (%~dp0) and TOOLS_ROOT is one
REM level up. Stripping trailing backslashes keeps path joins clean.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
for %%I in ("%ROOT%\..") do set "TOOLS_ROOT=%%~fI"
if not exist "%ROOT%\stream-overlay-backend" (
    echo ERROR: stream-overlay-backend not found under "%ROOT%".
    echo This launcher must live inside reveal-sc2-opponent-main.
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
echo [1/5] Starting Express overlay backend (stream-overlay-backend)...
start "SC2 -- Backend" /D "%ROOT%\stream-overlay-backend" cmd /k npm start

REM    Give the backend a moment to bind before dependents (watchers,
REM    pollers, GUI) start posting to /api/replay etc.
echo       Waiting 3 seconds for backend to initialize...
timeout /t 3 /nobreak >nul

REM -- 2. Replay Watcher (Python, watchers/replay_watcher.py) ------
REM    Live + threaded deep parse, posts to /api/replay and /api/replay/deep,
REM    cross-writes data/MyOpponentHistory.json and data/meta_database.json.
echo [2/4] Starting Replay Watcher (live + deep)...
start "SC2 -- Replay Watcher" cmd /k "cd /d %ROOT% && %PYTHON% -m watchers.replay_watcher"

REM -- 3. API Poller (Python helper) -------------------------------
REM    Reads identity (Pulse character IDs, player name, regions) from
REM    data\config.json and runs the SC2Pulse poller. Calls
REM    poller_launch.py directly so we don't double-shell through
REM    reveal-sc2-opponent.bat.
echo [3/4] Starting API Poller...
start "SC2 -- API Poller" cmd /k "cd /d %ROOT% && %PYTHON% scripts\poller_launch.py"

REM -- 4. Open the Web Analyzer in the default browser -------------
REM    The legacy SC2ReplayAnalyzer.py shim used to do this with
REM    webbrowser.open(); now it lives here so the unified launcher
REM    is fully self-contained. Polls /api/health (up to 30 attempts
REM    at 1s intervals) so the browser is opened only after the
REM    Express backend has actually bound :3000. Falls through after
REM    the timeout regardless -- worst case the user gets a "this
REM    site can't be reached" they can refresh.
echo [4/4] Waiting for backend health then opening Web Analyzer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for ($i=0; $i -lt 30; $i++) { try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {} Start-Sleep -Seconds 1 } ; if (-not $ok) { Write-Host '[Launcher] backend health probe timed out -- opening browser anyway' -ForegroundColor Yellow } ; Start-Process 'http://localhost:3000/analyzer/'"

echo.
echo  All components launched. This window will close in 3 seconds.
echo  Tip: close any panel window to stop just that component.
echo.
timeout /t 3 /nobreak >nul

endlocal
