<#
.SYNOPSIS
    Restore custom_builds.json (My Builds library) from the most recent
    backup that has more entries than what is currently on disk.

.DESCRIPTION
    Read-only by default: prints a report and exits.
    Pass -DoIt to actually copy the chosen backup over current. Original
    current file is preserved as custom_builds.json.before-restore-<ts>.bak
    so the operation is reversible.
#>
[CmdletBinding()]
param([switch]$DoIt)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dataDir = Resolve-Path (Join-Path $PSScriptRoot '..\reveal-sc2-opponent-main\data')
$current = Join-Path $dataDir 'custom_builds.json'

function Get-BuildCount {
    param([string]$Path)
    try {
        $j = Get-Content -Raw -Path $Path -Encoding utf8 | ConvertFrom-Json
        # custom_builds.json schemas observed: top-level array OR
        # top-level object with a 'builds' key. Handle both.
        if ($j -is [System.Array]) { return $j.Count }
        if ($j.builds) { return $j.builds.Count }
        return ($j.PSObject.Properties | Measure-Object).Count
    } catch {
        return -1
    }
}

Write-Host ''
Write-Host "=== custom_builds.json (My Builds) audit ===" -ForegroundColor Cyan
Write-Host "Data dir: $dataDir"
Write-Host ''

$candidates = Get-ChildItem -Path $dataDir -Filter 'custom_builds.json*' |
    Sort-Object LastWriteTime -Descending

if (-not $candidates) {
    Write-Host "No custom_builds.json files found." -ForegroundColor Yellow
    exit 1
}

Write-Host ("{0,-50} {1,10}  {2,8}  {3}" -f "File", "Bytes", "Builds", "Modified")
Write-Host ("-" * 100)

$results = @()
foreach ($f in $candidates) {
    $count = Get-BuildCount -Path $f.FullName
    $isCurrent = ($f.FullName -eq $current)
    $marker = if ($isCurrent) { ' <-- CURRENT' } else { '' }
    $results += [pscustomobject]@{
        Path       = $f.FullName
        Name       = $f.Name
        Bytes      = $f.Length
        Builds     = $count
        Modified   = $f.LastWriteTime
        IsCurrent  = $isCurrent
    }
    $countDisp = if ($count -ge 0) { $count } else { 'parse-fail' }
    Write-Host ("{0,-50} {1,10:N0}  {2,8}  {3}{4}" -f
        $f.Name, $f.Length, $countDisp,
        $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'),
        $marker)
}

# Pick the best backup: highest build count, ignoring the current file itself.
$best = $results |
    Where-Object { -not $_.IsCurrent -and $_.Builds -gt 0 } |
    Sort-Object Builds, Modified -Descending |
    Select-Object -First 1

$cur = $results | Where-Object { $_.IsCurrent } | Select-Object -First 1

Write-Host ''
Write-Host "=== Recommendation ===" -ForegroundColor Cyan
if (-not $best) {
    Write-Host "No backup parses cleanly. Don't restore blindly." -ForegroundColor Yellow
    exit 0
}
if ($cur -and $cur.Builds -ge $best.Builds) {
    Write-Host ("Current already has {0} builds, best backup has {1}. Nothing to restore." -f
        $cur.Builds, $best.Builds) -ForegroundColor Green
    exit 0
}

$gain = if ($cur) { $best.Builds - $cur.Builds } else { $best.Builds }
Write-Host ("Best backup: {0}" -f $best.Name)
Write-Host ("  builds in backup : {0}" -f $best.Builds)
Write-Host ("  builds currently : {0}" -f (if ($cur) { $cur.Builds } else { 0 }))
Write-Host ("  gain on restore  : +{0} builds" -f $gain) -ForegroundColor Green

if (-not $DoIt) {
    Write-Host ''
    Write-Host "This was a dry run. To actually restore, re-run with -DoIt:" -ForegroundColor Cyan
    Write-Host "  C:\SC2TOOLS\packaging\restore-mybuilds.ps1 -DoIt" -ForegroundColor White
    exit 0
}

# Real restore
$ts = (Get-Date).ToString('yyyyMMdd-HHmmss')
$preserved = "$current.before-restore-$ts.bak"
Write-Host ''
Write-Host "Preserving current as: $preserved"
Copy-Item -Path $current -Destination $preserved -Force
Write-Host "Restoring from        : $($best.Name)"
Copy-Item -Path $best.Path -Destination $current -Force
$after = Get-BuildCount -Path $current
Write-Host ("Done. New build count : {0}" -f $after) -ForegroundColor Green
Write-Host ''
Write-Host "Restart the backend (Ctrl+C then 'node index.js') so it re-reads the file."
