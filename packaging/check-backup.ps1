<#
.SYNOPSIS
    Diagnose meta_database.json backups before deciding which to restore.

.DESCRIPTION
    Lists every meta_database.json.pre-repair-*.bak under reveal-sc2-opponent-main\data,
    reports its size and game count, and tells you whether the backup
    parses cleanly. Read-only — does not modify anything.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dataDir = Join-Path $PSScriptRoot '..\reveal-sc2-opponent-main\data'
$dataDir = Resolve-Path $dataDir
Write-Host ''
Write-Host "=== meta_database.json backup audit ===" -ForegroundColor Cyan
Write-Host "Data dir: $dataDir"
Write-Host ''

$current = Join-Path $dataDir 'meta_database.json'
if (Test-Path $current) {
    $sz = (Get-Item $current).Length
    Write-Host ("Current : {0,12:N0} bytes  ({1,5:N1} MB)" -f $sz, ($sz / 1MB))
}

$backups = Get-ChildItem -Path $dataDir -Filter 'meta_database.json.*' |
    Where-Object { $_.Name -ne 'meta_database.json' } |
    Sort-Object Length -Descending

if (-not $backups) {
    Write-Host "No backup files found in $dataDir" -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host "All meta_database.json.* files in $dataDir (largest first):" -ForegroundColor Cyan
foreach ($f in $backups) {
    Write-Host ("  {0,12:N0} bytes  {1}" -f $f.Length, $f.Name)
}

Write-Host ''
Write-Host "=== Parse + game-count check (top 3 by size) ===" -ForegroundColor Cyan
$top = $backups | Select-Object -First 3
foreach ($f in $top) {
    Write-Host ''
    Write-Host "File: $($f.Name)" -ForegroundColor White
    Write-Host ("  size : {0:N0} bytes ({1:N1} MB)" -f $f.Length, ($f.Length / 1MB))
    try {
        $raw = Get-Content -Raw -Path $f.FullName -Encoding utf8
        $j = $raw | ConvertFrom-Json
        $buildCount = $j.PSObject.Properties.Count
        $gameCount = 0
        foreach ($prop in $j.PSObject.Properties) {
            if ($prop.Value -and $prop.Value.games) {
                $gameCount += $prop.Value.games.Count
            }
        }
        Write-Host "  parse: CLEAN" -ForegroundColor Green
        Write-Host "  builds: $buildCount"
        Write-Host "  games : $gameCount"
    } catch {
        Write-Host "  parse: FAILED -- $($_.Exception.Message)" -ForegroundColor Yellow
        $occ = ([regex]::Matches($raw, '"start_time"')).Count
        Write-Host "  rough game count by 'start_time' regex: $occ"
    }
}

Write-Host ''
Write-Host "=== Recommendation ===" -ForegroundColor Cyan
$best = $top | Select-Object -First 1
Write-Host "Largest backup with most games is probably: $($best.Name)"
Write-Host ""
Write-Host "If it parses CLEAN and has more games than current, restore with:"
Write-Host "  Copy-Item '$current' '$current.post-repair-bak'" -ForegroundColor Gray
Write-Host "  Copy-Item '$($best.FullName)' '$current' -Force" -ForegroundColor Gray
Write-Host ""
Write-Host "If it parses FAILED but has high regex game count, paste the output here"
Write-Host "and we'll write a deeper salvage script."
