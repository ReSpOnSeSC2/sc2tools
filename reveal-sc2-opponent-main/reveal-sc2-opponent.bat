@echo off
REM ============================================================
REM  reveal-sc2-opponent launcher
REM ------------------------------------------------------------
REM  Single source of truth for your SC2 Pulse Character ID(s).
REM  Both the PowerShell scanner AND the Node overlay backend
REM  pick up whatever's set here -- the PowerShell script writes
REM  the resolved IDs to character_ids.txt, which the backend
REM  reads on startup.
REM
REM  Leave SC2_CHARACTER_IDS empty to auto-detect from your local
REM  StarCraft II Documents folder. Otherwise set it to a comma-
REM  separated list, e.g.:
REM     set SC2_CHARACTER_IDS=12345678
REM     set SC2_CHARACTER_IDS=12345678,87654321
REM  Find your ID at https://sc2pulse.nephest.com/sc2/?#search
REM ============================================================
set SC2_CHARACTER_IDS=

start python sc2_mmr_scanner.py

if "%SC2_CHARACTER_IDS%"=="" (
    start powershell ^
    -NoExit ^
    -ExecutionPolicy bypass ^
    -Command "./Reveal-Sc2Opponent.ps1" ^
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
    -CharacterId %SC2_CHARACTER_IDS% ^
    -DisableQuickEdit ^
    -FilePath opponent.txt ^
    -RatingFormat long ^
    -RaceFormat short ^
    -Separator `r`n ^
    -Limit 1
)
