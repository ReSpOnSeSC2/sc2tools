# REMOVE_OCR_FILES.ps1
# -------------------
# One-shot cleanup script. Run from the repo root in PowerShell:
#     PowerShell -ExecutionPolicy Bypass -File .\REMOVE_OCR_FILES.ps1
#
# Deletes the now-inert OCR stubs and the calibration screenshot. The
# overlay backend has already been switched to SC2Pulse for all MMR.
# This file itself is safe to delete after running it once.

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$paths = @(
    "sc2_mmr_scanner.py",
    "calibrate_ocr.py",
    "loading_screen.png",
    "scanned_mmr.txt",
    "watchers\sc2_mmr_scanner.py",
    "watchers\__pycache__\sc2_mmr_scanner.cpython-310.pyc",
    "watchers\__pycache__\sc2_mmr_scanner.cpython-312.pyc",
    "__ZZ_to_delete_manually.tmp"
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        Remove-Item -Force -Path $p
        Write-Host "Deleted $p" -ForegroundColor Green
    } else {
        Write-Host "Skipped $p (not found)" -ForegroundColor DarkGray
    }
}
Write-Host "`nDone. You can now delete REMOVE_OCR_FILES.ps1 itself." -ForegroundColor Cyan
