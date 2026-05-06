<#
.SYNOPSIS
    Cross-process file lock for SC2Tools data/ files (Stage 3 of
    STAGE_DATA_INTEGRITY_ROADMAP).

.DESCRIPTION
    PowerShell side of the cross-language lockfile contract documented
    in core/file_lock.py and stream-overlay-backend/lib/file-lock.js.
    All three writers (Python replay watcher, Node Express backend,
    PowerShell live-phase scanner) coordinate by O_EXCL-creating a
    lockfile under data/.locks/<safe-name>.lock and tearing it down on
    release. Holders identify themselves by `lang` so cross-language
    PID-aliveness checks pick the right OS API.

    Lockfile shape:

        { "pid":      <int>,
          "host":     "<hostname>",
          "lang":     "ps",
          "platform": "Windows",
          "since":    <epoch_ms>,
          "stamp":    "<ISO8601>" }

    Acquisition: New-Object System.IO.FileStream with FileMode=CreateNew
    + FileShare=None gives us the same atomic O_EXCL semantics that
    the Python (`os.O_CREAT|os.O_EXCL`) and Node (`fs.openSync(..,'wx')`)
    sides rely on. If the file already exists, we read its metadata
    and decide:

      * Holder process not running OR lock older than -StaleAfterSec ->
        treat as stale and unlink + retry.
      * Holder running and lock young -> wait with exponential
        backoff (5 ms initial, 250 ms max) up to -TimeoutSec.
      * Timeout -> throw a terminating error so the caller can decide
        whether to abort the save or surface a diagnostic.

    Release: only if the on-disk metadata still carries OUR pid+since.
    A stale-steal somewhere else may have swapped a different holder
    in; removing it would orphan that holder, so we stay out of the
    way and best-effort log.

    Engineering preamble compliance:
      * Functions <= 30 lines.
      * No magic constants -- every knob is a parameter with a
        documented default that matches the Python / Node defaults.
      * Best-effort logging on release; never throws on cleanup.
      * Opt-out via $env:SC2TOOLS_DATA_LOCK_ENABLED = '0' for emergency
        rollback. The Lock-FileAtomic helper degrades to a no-op so
        the Save-History path is unaffected.

.PARAMETER TargetPath
    Absolute or relative path of the file you're about to mutate.
    The lockfile name is derived from the basename (clan-prefix
    stripped via the same safe-mapping the other languages use).

.PARAMETER ScriptBlock
    The work to perform under the lock. Runs once, on success.

.PARAMETER TimeoutSec
    Maximum time to wait for the lock. Defaults to 30 (matches the
    Python and Node sides).

.PARAMETER StaleAfterSec
    Lock age beyond which the holder is treated as stuck. Defaults
    to 30.

.EXAMPLE
    . "$PSScriptRoot/lib/Lock-FileAtomic.ps1"
    Lock-FileAtomic -TargetPath $HistoryFilePath -ScriptBlock {
        Write-FileAtomic -TargetPath $HistoryFilePath -Content $Json
    }

.NOTES
    Mirrors:
      core/file_lock.py
      stream-overlay-backend/lib/file-lock.js
#>

# --------------------------------------------------------------------
# Constants -- KEEP IN SYNC with the Python / Node defaults.
# --------------------------------------------------------------------
$script:LFA_LOCK_DIR_NAME           = '.locks'
$script:LFA_LOCK_SUFFIX             = '.lock'
$script:LFA_DEFAULT_TIMEOUT_SEC     = 30
$script:LFA_DEFAULT_STALE_AFTER_SEC = 30
$script:LFA_BACKOFF_INITIAL_MS      = 5
$script:LFA_BACKOFF_MAX_MS          = 250
$script:LFA_LANG_TAG                = 'ps'
$script:LFA_ENABLE_ENV_VAR          = 'SC2TOOLS_DATA_LOCK_ENABLED'
$script:LFA_DISABLE_VALUE           = '0'

# --------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------
function _LFA-IsDisabled {
    return ([Environment]::GetEnvironmentVariable($script:LFA_ENABLE_ENV_VAR) -eq $script:LFA_DISABLE_VALUE)
}

function _LFA-SafeLockName {
    param([Parameter(Mandatory)] [string] $TargetPath)
    # Match safe-name mapping in core/file_lock.py and lib/file-lock.js:
    # drop directory components, strip .bak / .tmp_restore suffixes so
    # related writes share one lock, and replace any character outside
    # [A-Za-z0-9._-] with '_'.
    $base = [System.IO.Path]::GetFileName($TargetPath)
    foreach ($strip in @('.bak', '.tmp_restore')) {
        if ($base.EndsWith($strip)) {
            $base = $base.Substring(0, $base.Length - $strip.Length)
        }
    }
    $sb = New-Object System.Text.StringBuilder $base.Length
    foreach ($c in $base.ToCharArray()) {
        if (($c -ge 'A' -and $c -le 'Z') -or
            ($c -ge 'a' -and $c -le 'z') -or
            ($c -ge '0' -and $c -le '9') -or
            $c -eq '.' -or $c -eq '_' -or $c -eq '-') {
            [void]$sb.Append($c)
        } else {
            [void]$sb.Append('_')
        }
    }
    return $sb.ToString() + $script:LFA_LOCK_SUFFIX
}

function _LFA-ResolveLockDir {
    param([Parameter(Mandatory)] [string] $TargetPath)
    # Compute parent directory of the absolute target path. We do this
    # WITHOUT Resolve-Path so the function works even when the target
    # file doesn't exist yet (a fresh install) and even when the parent
    # is itself missing (we then create it).
    $absTarget = if ([System.IO.Path]::IsPathRooted($TargetPath)) {
        $TargetPath
    } else {
        Join-Path (Get-Location).Path $TargetPath
    }
    $absTarget = [System.IO.Path]::GetFullPath($absTarget)
    $parent = [System.IO.Path]::GetDirectoryName($absTarget)
    if ([string]::IsNullOrEmpty($parent)) {
        $parent = (Get-Location).Path
    }
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $lockDir = Join-Path $parent $script:LFA_LOCK_DIR_NAME
    if (-not (Test-Path -LiteralPath $lockDir)) {
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    }
    return $lockDir
}

function _LFA-MakeMeta {
    return @{
        pid      = $PID
        host     = [System.Net.Dns]::GetHostName()
        lang     = $script:LFA_LANG_TAG
        platform = 'Windows'
        since    = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        stamp    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
}

function _LFA-IsPidAlive {
    # `Pid` is reserved as an automatic variable in PowerShell ($PID is
    # the running process id), so we name the parameter $ProcId to avoid
    # the clash.  Get-Process -Id is the canonical Windows API for
    # liveness; ESRCH-equivalent ("Cannot find a process with the
    # process identifier ...") raises a terminating ItemNotFound error
    # we swallow.
    param([Parameter(Mandatory)] [int] $ProcId)
    if ($ProcId -le 0) { return $false }
    try {
        $proc = Get-Process -Id $ProcId -ErrorAction Stop
        return ($null -ne $proc)
    } catch {
        return $false
    }
}

function _LFA-ReadMeta {
    param([Parameter(Mandatory)] [string] $LockPath)
    try {
        $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $null
    }
}

function _LFA-TryCreateLock {
    param(
        [Parameter(Mandatory)] [string]    $LockPath,
        [Parameter(Mandatory)] [hashtable] $Meta
    )
    # CreateNew + FileShare.None == O_CREAT|O_EXCL.  Throws on EEXIST.
    $fs = $null
    try {
        $fs = [System.IO.FileStream]::new(
            $LockPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
    } catch [System.IO.IOException] {
        # Most likely "The file already exists." Rare alternatives
        # (sharing violation) also signal "someone else owns it" so
        # we treat them all as "lock not acquired" and let the caller
        # retry / wait.
        if ($null -ne $fs) { try { $fs.Close() } catch {} }
        return $false
    } catch [System.UnauthorizedAccessException] {
        if ($null -ne $fs) { try { $fs.Close() } catch {} }
        return $false
    }
    try {
        $payload = ($Meta | ConvertTo-Json -Depth 5 -Compress)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $fs.Write($bytes, 0, $bytes.Length)
        $fs.Flush($true)  # FlushFileBuffers -- durability before rename
    } finally {
        try { $fs.Close() } catch {}
    }
    return $true
}

function _LFA-IsStale {
    param(
        $Meta,
        [Parameter(Mandatory)] [int] $StaleAfterSec
    )
    if ($null -eq $Meta) { return $true }
    $pidVal = $Meta.PSObject.Properties['pid']
    if ($null -eq $pidVal -or -not (_LFA-IsPidAlive -ProcId ([int]$pidVal.Value))) {
        return $true
    }
    $sinceProp = $Meta.PSObject.Properties['since']
    if ($null -ne $sinceProp) {
        $ageSec = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$sinceProp.Value) / 1000.0
        if ($ageSec -ge $StaleAfterSec) { return $true }
    }
    return $false
}

function _LFA-TrySteal {
    param(
        [Parameter(Mandatory)] [string] $LockPath,
        $Expected
    )
    # Re-read; bail out if metadata changed under us (someone else is
    # now legitimately holding it).
    $current = _LFA-ReadMeta -LockPath $LockPath
    if ($null -eq $current) { return $true }
    # $Expected = $null means our caller's first read failed -- almost
    # always because the holder was mid-write and the file was briefly
    # opened with FileShare.None. If THIS read returns valid metadata
    # the holder is healthy; we MUST NOT steal. Loop and let the next
    # iteration re-evaluate staleness with a clean read. Without this
    # guard a sharing-violation transient lets us delete a fresh
    # holder's lockfile and produce lost updates across processes.
    if ($null -eq $Expected) { return $false }
    $a = ($current | ConvertTo-Json -Depth 5 -Compress)
    $b = ($Expected | ConvertTo-Json -Depth 5 -Compress)
    if ($a -ne $b) { return $false }
    try {
        Remove-Item -LiteralPath $LockPath -Force -ErrorAction Stop
        return $true
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $true
    } catch {
        return $false
    }
}

function _LFA-ReleaseOwned {
    param(
        [Parameter(Mandatory)] [string]    $LockPath,
        [Parameter(Mandatory)] [hashtable] $Meta
    )
    $current = _LFA-ReadMeta -LockPath $LockPath
    if ($null -eq $current) { return }
    $curPid   = $current.PSObject.Properties['pid']
    $curSince = $current.PSObject.Properties['since']
    if (($null -eq $curPid)   -or ([int]$curPid.Value)   -ne $Meta.pid -or
        ($null -eq $curSince) -or ([int64]$curSince.Value) -ne $Meta.since) {
        Write-Verbose "[Lock-FileAtomic] release skipped: holder changed under us (pid=$($curPid.Value) ours=$($Meta.pid))"
        return
    }
    # Retry on transient sharing violations: another process briefly
    # holding a read handle (liveness check, antivirus indexer) makes
    # Remove-Item fail with ERROR_SHARING_VIOLATION on Windows. The
    # other reader releases within milliseconds.
    $maxAttempts = 6
    $lastErr = $null
    for ($attempt = 0; $attempt -lt $maxAttempts; $attempt++) {
        try {
            Remove-Item -LiteralPath $LockPath -Force -ErrorAction Stop
            return
        } catch [System.Management.Automation.ItemNotFoundException] {
            return
        } catch {
            $lastErr = $_
        }
        $delayMs = [Math]::Min(5 * [Math]::Pow(2, $attempt), 80)
        Start-Sleep -Milliseconds ([int]$delayMs)
    }
    if ($null -ne $lastErr) {
        Write-Verbose "[Lock-FileAtomic] release error: $($lastErr.Exception.Message)"
    }
}

# --------------------------------------------------------------------
# Public entrypoint
# --------------------------------------------------------------------
function Lock-FileAtomic {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]      $TargetPath,
        [Parameter(Mandatory)] [scriptblock] $ScriptBlock,
        [int] $TimeoutSec     = $script:LFA_DEFAULT_TIMEOUT_SEC,
        [int] $StaleAfterSec  = $script:LFA_DEFAULT_STALE_AFTER_SEC
    )
    if (_LFA-IsDisabled) {
        # Emergency rollback hatch: opt out via env var. No lock at all.
        return & $ScriptBlock
    }
    $lockDir  = _LFA-ResolveLockDir -TargetPath $TargetPath
    $lockPath = Join-Path $lockDir (_LFA-SafeLockName -TargetPath $TargetPath)
    $meta     = _LFA-MakeMeta
    $deadline = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ($TimeoutSec * 1000))
    $attempt  = 0
    $lastSeen = $null

    while ($true) {
        if (_LFA-TryCreateLock -LockPath $lockPath -Meta $meta) {
            try {
                return & $ScriptBlock
            } finally {
                _LFA-ReleaseOwned -LockPath $lockPath -Meta $meta
            }
        }
        $observed = _LFA-ReadMeta -LockPath $lockPath
        if (_LFA-IsStale -Meta $observed -StaleAfterSec $StaleAfterSec) {
            [void](_LFA-TrySteal -LockPath $lockPath -Expected $observed)
            $attempt = 0
            $lastSeen = $null
            continue
        }
        if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline) {
            $holderPid = if ($null -ne $observed -and $null -ne $observed.PSObject.Properties['pid']) { $observed.pid } else { '?' }
            throw "Lock-FileAtomic: timeout after ${TimeoutSec}s waiting on $lockPath (current holder pid=$holderPid)"
        }
        # Hash both serialised JSON strings so the comparison ignores
        # PowerShell PSCustomObject reference identity quirks.
        $obsHash  = if ($null -eq $observed) { '' } else { ($observed | ConvertTo-Json -Depth 5 -Compress) }
        $lastHash = if ($null -eq $lastSeen) { '' } else { ($lastSeen | ConvertTo-Json -Depth 5 -Compress) }
        if ($obsHash -ne $lastHash) {
            $attempt = 0
            $lastSeen = $observed
        } else {
            $attempt += 1
        }
        $delayMs = [Math]::Min($script:LFA_BACKOFF_INITIAL_MS * [Math]::Pow(2, $attempt), $script:LFA_BACKOFF_MAX_MS)
        Start-Sleep -Milliseconds ([int]$delayMs)
    }
}
