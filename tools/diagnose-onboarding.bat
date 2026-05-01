@echo off
REM ================================================================
REM  SC2 Tools onboarding diagnostic.
REM ----------------------------------------------------------------
REM  HOW TO USE:
REM    1. Double-click this .bat. It auto-discovers your replays
REM       and writes diagnose.txt next to itself.
REM    2. If your replays live in a non-standard location, drag
REM       the Multiplayer folder (the one with .SC2Replay files)
REM       directly onto this .bat and drop it. The dropped path
REM       is forwarded to the script.
REM    3. After it finishes, diagnose.txt opens in Notepad.
REM       Email or paste it back to whoever asked you to run this.
REM
REM  Reads only. Does not modify any data.
REM ================================================================

setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%diagnose-onboarding.py"
set "REPORT=%HERE%diagnose.txt"

REM Pick whatever Python is on PATH. The SC2 Tools installer adds
REM Python and registers the ``python`` command system-wide. If a
REM user has only ``py`` installed, edit PYEXE below.
set "PYEXE=python"
where %PYEXE% >nul 2>nul
if errorlevel 1 (
    echo ERROR: Python is not installed or not on PATH.
    echo Install Python 3.10+ from https://www.python.org/downloads/
    echo or re-run the SC2 Tools installer to get the bundled copy.
    pause
    endlocal & exit /b 1
)

if not exist "%SCRIPT%" (
    echo ERROR: missing %SCRIPT%
    echo This .bat must live next to diagnose-onboarding.py.
    pause
    endlocal & exit /b 1
)

REM Forward argv[1] -- this is the path Windows passes when a folder
REM is dragged onto the .bat. Empty arg is fine; the script handles it.
echo Running diagnostic... this can take 30-60 seconds.
echo.
%PYEXE% "%SCRIPT%" %1
set "RC=%ERRORLEVEL%"

if exist "%REPORT%" (
    echo.
    echo Opening diagnose.txt in Notepad...
    start "" notepad.exe "%REPORT%"
) else (
    echo.
    echo WARNING: diagnose.txt was not created. The script printed
    echo any output above this line.
)

echo.
echo Press any key to close this window.
pause >nul
endlocal & exit /b %RC%
