<#
.SYNOPSIS
    Fast meta_database.json audit + restore. Decides which backup to
    restore based on file size only (no slow ConvertFrom-Json).

.DESCRIPTION
    Read-only by default. Pass -DoIt to actually restore. Picks the
    largest meta_database.json.* file as the restore candidate, on the
    assumption that bigger == more games preserved.
#>
[CmdletBinding()]
param([switch]$DoIt)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dataDir = Resolve-Path (Join-Path $PSScriptRoot '..\reveal-sc2-opponent-main\data')
$current = Join-Path $dataDir 'meta_database.json'

Write-Host ''
Write-Host "=== meta_database.json (fast audit -- size-based) ===" -ForegroundColor Cyan
Write-Host "Data dir: $dataDir"
Write-Host ''

$files = Get-ChildItem -Path $dataDir -Filter 'meta_database.json*' |
    Sort-Object Length -Descending

if (-not $files) {
    Write-Host "No meta_database.json files found." -ForegroundColor Yellow
    exit 1
}

Write-Host ("{0,-65} {1,15}  {2,8}  {3}" -f
    "File", "Bytes", "MB", "Modified")
Write-Host ("-" * 110)

foreach ($f in $files) {
    $isCur = ($f.FullName -eq $current)
    $marker = if ($isCur) { ' <-- CURRENT' } else { '' }
    Write-Host ("{0,-65} {1,15:N0}  {2,8:N1}  {3}{4}" -f
        $f.Name, $f.Length, ($f.Length / 1MB),
        $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'),
        $marker)
}

# Best = largest file that ISN'T current. Skip .broken-* by default
# (those are corruption snapshots; they may be larger but unsafe).
$best = $files |
    Where-Object {
        $_.FullName -ne $current -and
        $_.Name -notlike '*.broken-*' -and
        $_.Name -notlike '*.before-restore-*' -and
        $_.Name -notlike '*.salvaged.*'
    } |
    Sort-Object Length -Descending |
    Select-Object -First 1

$cur = Get-Item -ErrorAction SilentlyContinue $current

Write-Host ''
Write-Host "=== Recommendation ===" -ForegroundColor Cyan

if (-not $best) {
    Write-Host "No safe backup candidate (all .broken-* or empty)." -ForegroundColor Yellow
    Write-Host "Largest file overall:"
    $files | Where-Object { $_.FullName -ne $current } | Select-Object -First 1 |
        ForEach-Object { Write-Host "  $($_.Name)  $('{0:N0}' -f $_.Length) bytes" }
    Write-Host "If that's a .broken-* and you want to try anyway, manually:"
    $largest = ($files | Where-Object { $_.FullName -ne $current } | Select-Object -First 1).FullName
    Write-Host "  Copy-Item -Force '$current' '$current.before-restore.bak'" -ForegroundColor Gray
    Write-Host "  Copy-Item -Force '$largest' '$current'" -ForegroundColor Gray
    exit 0
}

if ($cur -and $best.Length -le $cur.Length) {
    Write-Host ("Current ({0:N0} bytes) is already at least as large as best safe backup ({1:N0} bytes)." -f
        $cur.Length, $best.Length) -ForegroundColor Green
    Write-Host "Nothing to restore from a non-broken backup." -ForegroundColor Green
    Write-Host ''
    Write-Host "If you want to try a .broken-* anyway (not recommended without"
    Write-Host "first inspecting it), do it manually with Copy-Item."
    exit 0
}

$gainBytes = $best.Length - ($cur.Length)
$gainMb = $gainBytes / 1MB
Write-Host ("Best backup : {0}" -f $best.Name)
Write-Host ("  size      : {0:N0} bytes ({1:N1} MB)" -f $best.Length, ($best.Length / 1MB))
Write-Host ("  modified  : {0}" -f $best.LastWriteTime)
Write-Host ("  vs cur    : +{0:N0} bytes (+{1:N1} MB)" -f $gainBytes, $gainMb) -ForegroundColor Green

if (-not $DoIt) {
    Write-Host ''
    Write-Host "Dry run. To restore, re-run with -DoIt:" -ForegroundColor Cyan
    Write-Host "  C:\SC2TOOLS\packaging\restore-metadb-fast.ps1 -DoIt" -ForegroundColor White
    exit 0
}

$ts = (Get-Date).ToString('yyyyMMdd-HHmmss')
$preserved = "$current.before-restore-$ts.bak"
Write-Host ''
Write-Host "Preserving current as: $preserved"
Copy-Item -Path $current -Destination $preserved -Force
Write-Host "Restoring from        : $($best.Name)"
Copy-Item -Path $best.FullName -Destination $current -Force
$newSz = (Get-Item $current).Length
Write-Host ("Done. New size        : {0:N0} bytes ({1:N1} MB)" -f $newSz, ($newSz / 1MB)) -ForegroundColor Green
Write-Host ''
Write-Host 'Restart the backend (Ctrl+C the running node, then `node index.js`)'
Write-Host 'so it re-reads the file. Reload the SPA in the browser.'
