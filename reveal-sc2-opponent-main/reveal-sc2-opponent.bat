@echo off
REM ============================================================
REM  reveal-sc2-opponent launcher
REM ------------------------------------------------------------
REM  TWO ways to identify your SC2Pulse account, in priority order:
REM
REM    1. SC2_CHARACTER_IDS  -- comma-separated PULSE character IDs.
REM       These are NOT the same numbers as your local SC2 folder
REM       names (e.g., "1-S2-1-267727"). Find your real Pulse IDs
REM       at https://sc2pulse.nephest.com/sc2/?#search
REM       Example: ReSpOnSe is 994428 (NA) and 8970877 (EU).
REM
REM    2. SC2_PLAYER_NAME -- if SC2_CHARACTER_IDS is empty, the
REM       script does a Pulse name search across all configured
REM       regions and resolves the IDs for you.
REM
REM  ACTIVE_REGIONS controls priority order during the name search
REM  AND limits which regions are searched. List your most-played
REM  region first.
REM ============================================================

set SC2_CHARACTER_IDS=994428,8970877
set SC2_PLAYER_NAME=ReSpOnSe
set ACTIVE_REGIONS=us,eu,kr

if not "%SC2_CHARACTER_IDS%"=="" (
    start powershell ^
    -NoExit ^
    -ExecutionPolicy bypass ^
    -Command "./Reveal-Sc2Opponent.ps1" ^
    -CharacterId %SC2_CHARACTER_IDS% ^
    -ActiveRegion %ACTIVE_REGIONS% ^
    -DisableQuickEdit ^
    -FilePath opponent.txt ^
    -RatingFormat long ^
    -RaceFormat short ^
    -Separator `r`n ^
    -Limit 1
) else (
    start powershell ^
    -NoExit ^
    -ExecutionPolicy bypass ^
    -Command "./Reveal-Sc2Opponent.ps1" ^
    -PlayerName %SC2_PLAYER_NAME% ^
    -ActiveRegion %ACTIVE_REGIONS% ^
    -DisableQuickEdit ^
    -FilePath opponent.txt ^
    -RatingFormat long ^
    -RaceFormat short ^
    -Separator `r`n ^
    -Limit 1
)
