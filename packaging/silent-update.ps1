<#
.SYNOPSIS
    Silently install a new SC2 Tools release on top of the running install.

.DESCRIPTION
    Spawned by routes/version.js when the SPA Update button is clicked.
    Detached from the parent backend (which exits within 5s of spawn so
    the installer can replace files), this script:

      1. Waits up to 30s for the backend's PID to exit.
      2. Downloads the new installer to %TEMP%\ from -ExeUrl.
      3. Downloads -Sha256Url, extracts the expected hash, and verifies
         the installer matches.
      4. Runs the installer with NSIS /S silent flag and -Wait until it
         exits.
      5. Re-launches the desktop launcher via the install location stored
         in HKCU\Software\SC2Tools\InstallLocation by the original
         installer.

    Every step writes to a per-run log under %LOCALAPPDATA%\SC2Tools\logs
    so the user / a support ticket can see why an auto-update failed.

.PARAMETER ExeUrl
    Direct URL to the SC2Tools-Setup-<version>.exe asset on a GitHub
    Release. Browser download URL, not the API URL.

.PARAMETER Sha256Url
    URL to the matching .sha256 sidecar produced by build-installer.ps1.
    Sidecar format: "<64-hex>  <filename>".

.PARAMETER ParentPid
    PID of the spawning backend process. We poll-wait for it to exit
    before running the installer so we never collide on file handles.

.PARAMETER Tag
    Version tag (e.g. "1.0.1"). Used only as a filename hint for the
    downloaded installer; verification still goes through SHA256.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File silent-update.ps1 `
        -ExeUrl    "https://github.com/.../SC2Tools-Setup-1.0.1.exe" `
        -Sha256Url "https://github.com/.../SC2Tools-Setup-1.0.1.exe.sha256" `
        -ParentPid 12345 `
        -Tag       "1.0.1"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ExeUrl,
    [Parameter(Mandatory)] [string]$Sha256Url,
    [Parameter(Mandatory)] [int]   $ParentPid,
    [Parameter(Mandatory)] [string]$Tag
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ----- Constants ------------------------------------------------------------
$WAIT_PARENT_TIMEOUT_SEC = 30
$WAIT_PARENT_POLL_MS     = 500
$REG_INSTALL_KEY         = 'HKCU:\Software\SC2Tools'
$LOG_DIR                 = Join-Path $env:LOCALAPPDATA 'SC2Tools\logs'
$DOWNLOAD_DIR            = $env:TEMP

# ----- Logging --------------------------------------------------------------
function Initialize-Logging {
    if (-not (Test-Path $LOG_DIR)) {
        New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
    }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $script:LOG_FILE = Join-Path $LOG_DIR "silent-update-$stamp.log"
    "SC2 Tools silent update -- $stamp" | Out-File $script:LOG_FILE -Encoding utf8
}

function Write-Log {
    param([string]$Level, [string]$Message)
    $line = '[{0}] {1} {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
    Add-Content -Path $script:LOG_FILE -Value $line -Encoding utf8
}

# ----- Step helpers (each <= 30 lines) -------------------------------------
function Wait-ForParentExit {
    param([int]$Pid)
    $deadline = (Get-Date).AddSeconds($WAIT_PARENT_TIMEOUT_SEC)
    while ((Get-Date) -lt $deadline) {
        $running = Get-Process -Id $Pid -ErrorAction SilentlyContinue
        if (-not $running) {
            Write-Log INFO "parent pid $Pid exited"
            return
        }
        Start-Sleep -Milliseconds $WAIT_PARENT_POLL_MS
    }
    Write-Log WARN "parent pid $Pid still running after $WAIT_PARENT_TIMEOUT_SEC s; proceeding anyway"
}

function Get-RemoteFile {
    param([string]$Url, [string]$DestPath)
    $tmp = "$DestPath.partial"
    Write-Log INFO "GET $Url"
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    Move-Item -Force $tmp $DestPath
}

function Read-ExpectedSha256 {
    param([string]$Sha256FilePath)
    # Sidecar format: "<64-hex>  <filename>" (one line, two-space sep).
    $line = (Get-Content -Path $Sha256FilePath -TotalCount 1 -Raw).Trim()
    $hex  = $line -split '\s+', 2 | Select-Object -First 1
    if ($hex -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Bad SHA256 sidecar contents: $line"
    }
    return $hex.ToUpper()
}

function Confirm-Sha256 {
    param([string]$ExePath, [string]$Expected)
    $actual = (Get-FileHash -Path $ExePath -Algorithm SHA256).Hash.ToUpper()
    if ($actual -ne $Expected) {
        Remove-Item -Force $ExePath -ErrorAction SilentlyContinue
        throw "SHA256 mismatch: expected $Expected actual $actual"
    }
    Write-Log INFO "SHA256 verified ($Expected)"
}

function Invoke-SilentInstaller {
    param([string]$ExePath)
    Write-Log INFO "running installer $ExePath /S"
    $proc = Start-Process -FilePath $ExePath -ArgumentList @('/S') -Wait -PassThru
    Write-Log INFO ("installer exited code={0}" -f $proc.ExitCode)
    if ($proc.ExitCode -ne 0) {
        throw "Installer exit code $($proc.ExitCode); see $LOG_FILE"
    }
}

function Restart-Launcher {
    if (-not (Test-Path $REG_INSTALL_KEY)) {
        Write-Log WARN "no $REG_INSTALL_KEY; skipping relaunch (user can use shortcut)"
        return
    }
    $installDir = (Get-ItemProperty -Path $REG_INSTALL_KEY).InstallLocation
    if (-not $installDir -or -not (Test-Path $installDir)) {
        Write-Log WARN "install dir $installDir missing; skipping relaunch"
        return
    }
    $launcher = Join-Path $installDir 'SC2Replay-Analyzer\SC2ReplayAnalyzer.py'
    $pythonw  = Join-Path $installDir 'python\pythonw.exe'
    if (-not (Test-Path $launcher) -or -not (Test-Path $pythonw)) {
        Write-Log WARN "launcher or pythonw missing under $installDir; skipping relaunch"
        return
    }
    Start-Process -FilePath $pythonw -ArgumentList @($launcher) -WorkingDirectory $installDir
    Write-Log INFO "relaunched $launcher"
}

# ----- Main -----------------------------------------------------------------
function Invoke-SilentUpdate {
    Initialize-Logging
    Write-Log INFO "begin tag=$Tag pid=$ParentPid"
    Write-Log INFO "exeUrl=$ExeUrl"
    Write-Log INFO "sha256Url=$Sha256Url"
    Wait-ForParentExit -Pid $ParentPid

    $exePath = Join-Path $DOWNLOAD_DIR "SC2Tools-Setup-$Tag.exe"
    $shaPath = Join-Path $DOWNLOAD_DIR "SC2Tools-Setup-$Tag.exe.sha256"
    Get-RemoteFile -Url $ExeUrl    -DestPath $exePath
    Get-RemoteFile -Url $Sha256Url -DestPath $shaPath

    $expected = Read-ExpectedSha256 -Sha256FilePath $shaPath
    Confirm-Sha256 -ExePath $exePath -Expected $expected

    Invoke-SilentInstaller -ExePath $exePath
    Restart-Launcher
    Write-Log INFO "complete"
}

try {
    Invoke-SilentUpdate
} catch {
    if ($script:LOG_FILE) {
        Write-Log ERROR ($_ | Out-String)
    }
    throw
}
