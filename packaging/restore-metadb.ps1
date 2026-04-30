<#
.SYNOPSIS
    Inspect every meta_database.json* file in data\ and offer to restore
    the largest backup with the most games. Powers both "Opponents ->
    build orders" and the "My Builds" tab in the analyzer SPA.

.DESCRIPTION
    Read-only by default: prints a report and exits. Pass -DoIt to copy
    the chosen backup over the live meta_database.json. Always preserves
    the current file as meta_database.json.before-restore-<ts>.bak first
    so the operation is reversible.
#>
[CmdletBinding()]
param([switch]$DoIt)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dataDir = Resolve-Path (Join-Path $PSScriptRoot '..\reveal-sc2-opponent-main\data')
$current = Join-Path $dataDir 'meta_database.json'

function Get-MetaStats {
    param([string]$Path)
    $stats = [pscustomobject]@{
        Parses    = $false
        Builds    = -1
        Games     = -1
        ParseErr  = $null
    }
    try {
        $j = Get-Content -Raw -Path $Path -Encoding utf8 | ConvertFrom-Json
        $stats.Parses = $true
        $stats.Builds = ($j.PSObject.Properties | Measure-Object).Count
        $g = 0
        foreach ($prop in $j.PSObject.Properties) {
            if ($prop.Value -and $prop.Value.games) {
                $g += $prop.Value.games.Count
            }
        }
        $stats.Games = $g
    } catch {
        $stats.ParseErr = $_.Exception.Message
    }
    return $stats
}

Write-Host ''
Write-Host "=== meta_database.json audit ===" -ForegroundColor Cyan
Write-Host "Data dir: $dataDir"
Write-Host ''

$candidates = Get-ChildItem -Path $dataDir -Filter 'meta_database.json*' |
    Sort-Object Length -Descending

if (-not $candidates) {
    Write-Host "No meta_database.json files found." -ForegroundColor Yellow
    exit 1
}

Write-Host ("{0,-65} {1,12}  {2,8}  {3,8}  {4}" -f
    "File", "Bytes", "Builds", "Games", "Parse")
Write-Host ("-" * 110)

$rows = @()
foreach ($f in $candidates) {
    $isCur = ($f.FullName -eq $current)
    $st = Get-MetaStats -Path $f.FullName
    $rows += [pscustomobject]@{
        Path      = $f.FullName
        Name      = $f.Name
        Bytes     = $f.Length
        Builds    = $st.Builds
        Games     = $st.Games
        Parses    = $st.Parses
        IsCurrent = $isCur
    }
    $marker = if ($isCur) { ' <-- CURRENT' } else { '' }
    $parseDisp = if ($st.Parses) { 'OK' } else { 'FAIL' }
    $bd = if ($st.Builds -ge 0) { $st.Builds } else { '?' }
    $gm = if ($st.Games -ge 0) { $st.Games } else { '?' }
    Write-Host ("{0,-65} {1,12:N0}  {2,8}  {3,8}  {4}{5}" -f
        $f.Name, $f.Length, $bd, $gm, $parseDisp, $marker)
}

# Pick the candidate with the most games that ALSO parses cleanly,
# excluding the current file itself.
$best = $rows |
    Where-Object { -not $_.IsCurrent -and $_.Parses -and $_.Games -gt 0 } |
    Sort-Object Games -Descending |
    Select-Object -First 1
$cur = $rows | Where-Object { $_.IsCurrent } | Select-Object -First 1

Write-Host ''
Write-Host "=== Recommendation ===" -ForegroundColor Cyan
if (-not $best) {
    Write-Host "No backup parses cleanly. Don't restore blindly." -ForegroundColor Yellow
    Write-Host "If a corrupted backup has a much larger game count by regex, we"
    Write-Host "can write a deeper salvage script. Paste this audit output."
    exit 0
}
$curGames = if ($cur -and $cur.Parses) { $cur.Games } else { 0 }
if ($curGames -ge $best.Games) {
    Write-Host ("Current already has {0} games, best backup has {1}. Nothing to restore." -f
        $curGames, $best.Games) -ForegroundColor Green
    exit 0
}
$gain = $best.Games - $curGames
Write-Host ("Best backup    : {0}" -f $best.Name)
Write-Host ("  builds       : {0}" -f $best.Builds)
Write-Host ("  games        : {0}" -f $best.Games)
Write-Host ("  vs. current  : {0} -> {1}  (+{2} games recovered)" -f
    $curGames, $best.Games, $gain) -ForegroundColor Green

if (-not $DoIt) {
    Write-Host ''
    Write-Host "Dry run. To actually restore, re-run with -DoIt:" -ForegroundColor Cyan
    Write-Host "  C:\SC2TOOLS\packaging\restore-metadb.ps1 -DoIt" -ForegroundColor White
    exit 0
}

$ts = (Get-Date).ToString('yyyyMMdd-HHmmss')
$preserved = "$current.before-restore-$ts.bak"
Write-Host ''
Write-Host "Preserving current as: $preserved"
Copy-Item -Path $current -Destination $preserved -Force
Write-Host "Restoring from        : $($best.Name)"
Copy-Item -Path $best.Path -Destination $current -Force

$after = Get-MetaStats -Path $current
Write-Host ('Done. New: builds={0}, games={1}' -f $after.Builds, $after.Games) -ForegroundColor Green
Write-Host ''
Write-Host 'Restart the backend (Ctrl+C the running node, then `node index.js`)'
Write-Host 'so it re-reads the file. Reload the SPA in the browser.'
