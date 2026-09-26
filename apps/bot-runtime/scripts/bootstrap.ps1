param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
        & $Python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed.' }
    }
    & '.\.venv\Scripts\python.exe' -m pip install --no-cache-dir -e '.[dev]'
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & '.\.venv\Scripts\python.exe' -m pluto_sc2 doctor
    if ($LASTEXITCODE -ne 0) { throw 'Runtime check failed.' }
} finally { Pop-Location }
