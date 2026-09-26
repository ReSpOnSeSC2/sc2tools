$ErrorActionPreference = 'Stop'
$replayWorkspace = Split-Path -Parent $PSScriptRoot
$replayPython = Join-Path $replayWorkspace '.venv\Scripts\pythonw.exe'
if (-not (Test-Path -LiteralPath $replayPython)) {
    throw 'The project Python environment is missing. Run scripts/bootstrap.ps1 first.'
}
Start-Process -FilePath $replayPython -ArgumentList @('-m', 'pluto_sc2.replay_browser', '--open-browser') -WorkingDirectory $replayWorkspace -WindowStyle Hidden
