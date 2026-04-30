<#
.SYNOPSIS
    Build the SC2 Tools Windows installer (.exe).

.DESCRIPTION
    Stages the deployable tree under build\stage, downloads embeddable
    Python 3.12 and pre-installs every Python and Node.js dependency, then
    invokes makensis.exe to produce dist\SC2Tools-Setup-<Version>.exe and
    a matching .sha256 sidecar.

    Pre-baking dependencies at build time means the end user installer is
    a single file copy + shortcut creation pass. Crucially, the user does
    not need PyPI / npm registry access at install time, which keeps the
    flow working on the offline / corporate-network machines our streamer
    audience often runs on (Hard Rule #6: UX must work without docs).

.PARAMETER Version
    Installer version string. Defaults to `git describe --tags --always`
    or 'dev' if the repo is not tagged. CI passes the tag here.

.PARAMETER PythonVersion
    Embeddable Python release to bundle. Pinned default 3.12.7. The known
    SHA256 must be present in $PYTHON_SHA256_BY_VERSION below; otherwise
    the build aborts before download.

.PARAMETER SkipPython
    Reuse an existing build\stage\python\ tree. Used by iterative dev to
    skip the ~15 MB download + pip install on every build.

.PARAMETER SkipNpm
    Reuse an existing node_modules\ tree.

.PARAMETER Test
    After the .exe is produced, run a silent install into a scratch dir,
    verify key paths exist, then uninstall. CI uses this on every build.

.EXAMPLE
    .\build-installer.ps1
    Build with the current git tag.

.EXAMPLE
    .\build-installer.ps1 -Version 1.0.0 -Test
    Used by .github\workflows\release.yml on tag push.
#>

[CmdletBinding()]
param(
    [string]$Version       = '',
    [string]$PythonVersion = '3.12.7',
    [switch]$SkipPython,
    [switch]$SkipNpm,
    [switch]$Test,
    [switch]$SmokeOnly  # Re-test an existing dist\*.exe without rebuilding.
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'  # speeds up Invoke-WebRequest

# ----- Constants ------------------------------------------------------------
# Pinned SHA256 hashes for Windows embeddable Python distributions.
# Source: https://www.python.org/ftp/python/<ver>/python-<ver>-embed-amd64.zip.spdx.json
# When bumping, fetch the SBOM and copy the SPDXRef-PACKAGE-cpython
# checksum here. The build aborts with a clear error if a caller passes
# a -PythonVersion not listed below.
$PYTHON_SHA256_BY_VERSION = @{
    '3.12.7' = '0D57BB6CB078B74D23DBFE91F77D6780D45BED328911609F1F7EE2BA1606BF44'
}
$REPO_ROOT     = Resolve-Path (Join-Path $PSScriptRoot '..')
$PACKAGING_DIR = Resolve-Path $PSScriptRoot
$BUILD_DIR     = Join-Path $REPO_ROOT 'build'
$STAGE_DIR     = Join-Path $BUILD_DIR 'stage'
$DIST_DIR      = Join-Path $REPO_ROOT 'dist'
# Directory names to exclude (robocopy /XD, basename match at any depth).
$STAGE_EXCLUDE_DIRS = @(
    '.git', '.github', '.claude', '.idea', '.vscode',
    'build', 'dist', 'node_modules', 'venv', '.venv',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    'tests'
)
# File patterns to exclude (robocopy /XF, supports wildcards). The
# meta_database / MyOpponentHistory / custom_builds / profile / config
# entries are the user's runtime data; the wizard recreates them on
# first launch. build_definitions.json IS part of the codebase, so we
# keep it.
$STAGE_EXCLUDE_FILES = @(
    'New Text Document.txt',
    'meta_database.json*',
    'MyOpponentHistory.json*',
    'custom_builds.json*',
    'profile.json*',
    'config.json*',
    'community_sync_queue.json*',
    'community_builds.cache.json*',
    'analyzer.log*',
    '*.disabled',
    '*.pyc', '*.pyo'
)
# _pth file ships with embeddable Python; uncommenting `import site`
# enables pip / site-packages discovery.
$PYTHON_PTH_PATCH = @{
    Match   = '^#import site'
    Replace = 'import site'
}
$INSTALLER_NSI = Join-Path $PACKAGING_DIR 'installer.nsi'

# ----- Helpers (each <= 30 lines) ------------------------------------------
function Resolve-Version {
    param([string]$Override)
    if ($Override) { return $Override }
    try {
        $tag = (& git -C $REPO_ROOT describe --tags --always 2>$null).Trim()
        if ($tag) { return ($tag -replace '^v', '') }
    } catch { }
    return 'dev'
}

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host ('=== ' + $Message) -ForegroundColor Cyan
}

function Find-MakeNsis {
    $candidates = @(
        'C:\Program Files (x86)\NSIS\makensis.exe',
        'C:\Program Files\NSIS\makensis.exe',
        "$env:ChocolateyInstall\bin\makensis.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    $cmd = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'makensis.exe not found. Install NSIS 3.x from https://nsis.sourceforge.io/Download or `choco install nsis`.'
}

function Get-RemoteFile {
    param(
        [Parameter(Mandatory)] [string]$Url,
        [Parameter(Mandatory)] [string]$DestPath,
        [string]$ExpectedSha256
    )
    $tmp = "$DestPath.partial"
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    if ($ExpectedSha256) {
        $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash
        if ($actual -ne $ExpectedSha256.ToUpper()) {
            Remove-Item $tmp -Force
            throw "SHA256 mismatch for $Url`n  expected $ExpectedSha256`n  actual   $actual"
        }
    }
    Move-Item -Force $tmp $DestPath  # atomic rename
}

function New-CleanDir {
    param([string]$Path)
    if (Test-Path $Path) { Remove-Item -Recurse -Force $Path }
    New-Item -ItemType Directory -Path $Path | Out-Null
}

function Copy-StageTree {
    Write-Step 'Staging source tree'
    if (Test-Path $STAGE_DIR) { Remove-Item -Recurse -Force $STAGE_DIR }
    New-Item -ItemType Directory -Path $STAGE_DIR | Out-Null
    # robocopy: /XD = exclude dirs, /XF = exclude files (wildcards OK).
    $robocopyArgs = @($REPO_ROOT, $STAGE_DIR, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') +
                    ($STAGE_EXCLUDE_DIRS  | ForEach-Object { @('/XD', $_) } | ForEach-Object { $_ }) +
                    ($STAGE_EXCLUDE_FILES | ForEach-Object { @('/XF', $_) } | ForEach-Object { $_ })
    & robocopy.exe @robocopyArgs | Out-Null
    # robocopy returns non-error codes 0-7; treat 8+ as failure.
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit $LASTEXITCODE" }
    $sizeMb = '{0:N1}' -f ((Get-ChildItem -Recurse $STAGE_DIR | Measure-Object Length -Sum).Sum / 1MB)
    $count  = (Get-ChildItem -Recurse $STAGE_DIR | Measure-Object).Count
    Write-Host "  staged $count files ($sizeMb MB)"
}

function Install-EmbeddablePython {
    Write-Step "Installing embeddable Python $PythonVersion"
    $pyDir = Join-Path $STAGE_DIR 'python'
    if ($SkipPython -and (Test-Path $pyDir)) {
        Write-Host '  -SkipPython: reusing existing python\'
        return
    }
    if (-not $PYTHON_SHA256_BY_VERSION.ContainsKey($PythonVersion)) {
        throw "Python $PythonVersion not pinned in PYTHON_SHA256_BY_VERSION."
    }
    New-CleanDir $pyDir
    $zip = Join-Path $BUILD_DIR "python-$PythonVersion-embed-amd64.zip"
    $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    Get-RemoteFile -Url $url -DestPath $zip -ExpectedSha256 $PYTHON_SHA256_BY_VERSION[$PythonVersion]
    Expand-Archive -Path $zip -DestinationPath $pyDir -Force

    # Enable site-packages so pip can install into Lib\site-packages.
    $pth = Get-ChildItem $pyDir -Filter 'python*._pth' | Select-Object -First 1
    if (-not $pth) { throw "python._pth file missing in $pyDir" }
    (Get-Content $pth.FullName) `
        -replace $PYTHON_PTH_PATCH.Match, $PYTHON_PTH_PATCH.Replace `
        | Set-Content $pth.FullName -Encoding ASCII

    # get-pip.py from PyPA's canonical bootstrap. PSF retired the
    # per-Python-version path (/pip/3.12/) in early 2026. The bootstrap
    # script is self-updating and not version-pinnable; reproducibility
    # comes from the pinned requirements.txt that gets installed AFTER.
    $getPip = Join-Path $BUILD_DIR 'get-pip.py'
    Get-RemoteFile -Url 'https://bootstrap.pypa.io/get-pip.py' -DestPath $getPip
    & (Join-Path $pyDir 'python.exe') $getPip --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw "get-pip.py failed (exit $LASTEXITCODE)" }

    # Some pinned deps ship sdist-only (notably mpyq, a sc2reader
    # transitive). Building from source needs setuptools.build_meta,
    # which the embeddable Python distribution does NOT bundle. Install
    # setuptools + wheel before pip install -r requirements.txt so the
    # source build has a backend.
    & (Join-Path $pyDir 'python.exe') -m pip install --no-warn-script-location setuptools wheel
    if ($LASTEXITCODE -ne 0) {
        throw "setuptools/wheel install failed (exit $LASTEXITCODE)"
    }
}

function Install-PythonRequirements {
    Write-Step 'Installing pinned Python requirements into bundled interpreter'
    $py     = Join-Path $STAGE_DIR 'python\python.exe'
    $reqDir = Join-Path $STAGE_DIR 'SC2Replay-Analyzer'
    & $py -m pip install --no-warn-script-location -r (Join-Path $reqDir 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }
    # Also install reveal-sc2-opponent-main/requirements.txt (subset, but
    # listed independently so a future split is painless).
    $revReq = Join-Path $STAGE_DIR 'reveal-sc2-opponent-main\requirements.txt'
    if (Test-Path $revReq) {
        & $py -m pip install --no-warn-script-location -r $revReq
        if ($LASTEXITCODE -ne 0) { throw "pip install (reveal) failed (exit $LASTEXITCODE)" }
    }
    # Strip __pycache__ for reproducible hashes; Python regenerates on first
    # import.
    Get-ChildItem $STAGE_DIR -Recurse -Directory -Filter '__pycache__' |
        Remove-Item -Recurse -Force
}

function Install-NodeModules {
    Write-Step 'Pre-baking node_modules via npm ci'
    $backendDir = Join-Path $STAGE_DIR 'reveal-sc2-opponent-main\stream-overlay-backend'
    if ($SkipNpm -and (Test-Path (Join-Path $backendDir 'node_modules'))) {
        Write-Host '  -SkipNpm: reusing existing node_modules'
        return
    }
    Push-Location $backendDir
    try {
        & npm ci --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
}

function Invoke-MakeNsis {
    Write-Step 'Compiling installer.nsi'
    if (-not (Test-Path $DIST_DIR)) { New-Item -ItemType Directory -Path $DIST_DIR | Out-Null }
    $makensis = Find-MakeNsis
    $args = @(
        "/DVERSION=$Version",
        "/DSTAGE_DIR=$STAGE_DIR",
        "/DDIST_DIR=$DIST_DIR",
        $INSTALLER_NSI
    )
    & $makensis @args
    if ($LASTEXITCODE -ne 0) { throw "makensis failed (exit $LASTEXITCODE)" }
}

function Write-Sha256Sidecar {
    param([string]$ExePath)
    $hash    = (Get-FileHash $ExePath -Algorithm SHA256).Hash.ToLower()
    $sidecar = "$ExePath.sha256"
    $name    = Split-Path $ExePath -Leaf
    "$hash  $name`n" | Set-Content -Encoding ASCII -NoNewline $sidecar
    Write-Host "  $name  sha256=$hash" -ForegroundColor Green
}

function Test-Installer {
    param([string]$ExePath)
    Write-Step 'Smoke-testing installer (silent install + uninstall)'
    $scratch = Join-Path $env:TEMP "sc2tools-smoke-$(Get-Random)"
    # Start-Process -Wait blocks until NSIS /S finishes writing files.
    # Plain `& $exe` returns immediately because NSIS detaches a worker.
    Start-Process -FilePath $ExePath -ArgumentList @('/S', "/D=$scratch") -Wait
    $expected = @('python\python.exe', 'SC2Replay-Analyzer\SC2ReplayAnalyzer.py',
                  'reveal-sc2-opponent-main\stream-overlay-backend\index.js',
                  'data\config.json', 'Uninstall.exe')
    foreach ($rel in $expected) {
        $full = Join-Path $scratch $rel
        if (-not (Test-Path $full)) { throw "Smoke check failed: $rel missing under $scratch" }
    }
    Write-Host "  all expected paths present under $scratch"
    Start-Process -FilePath (Join-Path $scratch 'Uninstall.exe') -ArgumentList @('/S') -Wait
    if (Test-Path (Join-Path $scratch 'python')) {
        Write-Warning "Uninstall did not remove python\ -- inspect $scratch"
    }
}

# ----- Main -----------------------------------------------------------------
function Invoke-Build {
    $resolved = Resolve-Version -Override $Version
    $script:Version = $resolved
    $exe = Join-Path $DIST_DIR "SC2Tools-Setup-$resolved.exe"
    if ($SmokeOnly) {
        Write-Host "SC2 Tools installer SMOKE TEST  version=$resolved" -ForegroundColor Yellow
        if (-not (Test-Path $exe)) { throw "No existing installer at $exe" }
        Test-Installer -ExePath $exe
        Write-Host "`nSmoke test passed -> $exe" -ForegroundColor Green
        return
    }
    Write-Host "SC2 Tools installer build  version=$resolved" -ForegroundColor Yellow
    if (-not (Test-Path $BUILD_DIR)) { New-Item -ItemType Directory -Path $BUILD_DIR | Out-Null }
    Copy-StageTree
    Install-EmbeddablePython
    Install-PythonRequirements
    Install-NodeModules
    Invoke-MakeNsis
    if (-not (Test-Path $exe)) { throw "Expected output $exe not produced." }
    Write-Sha256Sidecar -ExePath $exe
    if ($Test) { Test-Installer -ExePath $exe }
    Write-Host "`nDone -> $exe" -ForegroundColor Green
}

Invoke-Build
