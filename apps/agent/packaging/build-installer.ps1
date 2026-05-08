<#
.SYNOPSIS
    Builds the SC2 Tools Agent Windows installer.

.DESCRIPTION
    End-to-end pipeline:
      1. Create a clean virtualenv inside apps/agent/.build-venv.
      2. Install requirements + PyInstaller into it.
      3. Run PyInstaller against packaging/sc2tools_agent.spec.
      4. Run NSIS against packaging/installer.nsi (when -Installer is set).
      5. Optionally code-sign the resulting setup .exe (when -SigningCert
         is provided).

.PARAMETER Version
    Semver string to embed in the installer + the EXE's VERSIONINFO.
    Defaults to whatever sc2tools_agent.__version__ reports.

.PARAMETER Installer
    Build the NSIS installer in addition to the bare .exe. Defaults to
    $true on the build server, $false during quick local iteration.

.PARAMETER SigningCert
    Path to the .pfx EV code-signing certificate. When set, signtool is
    invoked on the final installer with /tr (timestamp) + SHA256.

.PARAMETER Clean
    Wipe build/, dist/, and .build-venv/ before starting. Use this for
    release builds; skip it when you're iterating on the spec file and
    want to keep PyInstaller's incremental cache.

.EXAMPLE
    pwsh packaging/build-installer.ps1 -Version 0.2.0 -Installer
#>

[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Installer,
    [string]$SigningCert,
    [string]$SigningCertPasswordEnv = "SC2TOOLS_SIGNING_PASSWORD",
    [string]$TimestampUrl = "http://timestamp.sectigo.com",
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$AgentRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvDir   = Join-Path $AgentRoot ".build-venv"
$DistDir   = Join-Path $AgentRoot "dist"
$BuildDir  = Join-Path $AgentRoot "build"
$Spec      = Join-Path $PSScriptRoot "sc2tools_agent.spec"
$Nsi       = Join-Path $PSScriptRoot "installer.nsi"

function Resolve-AgentVersion {
    if ($Version) { return $Version }
    $initPy = Join-Path $AgentRoot "sc2tools_agent\__init__.py"
    if (-not (Test-Path $initPy)) {
        throw "Cannot find $initPy - provide -Version explicitly."
    }
    $line = Select-String -Path $initPy -Pattern '^__version__\s*=\s*"([^"]+)"' -ErrorAction Stop
    if (-not $line) {
        throw "No __version__ in $initPy - provide -Version explicitly."
    }
    return $line.Matches[0].Groups[1].Value
}

function Invoke-Step($Label, [scriptblock]$Body) {
    Write-Host "==> $Label" -ForegroundColor Cyan
    & $Body
    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
        throw "Step '$Label' failed with exit code $LASTEXITCODE"
    }
}

if ($Clean) {
    Invoke-Step "Cleaning build artefacts" {
        foreach ($p in @($DistDir, $BuildDir, $VenvDir)) {
            if (Test-Path $p) { Remove-Item -Recurse -Force $p }
        }
    }
}

$AgentVersion = Resolve-AgentVersion
Write-Host "Building SC2 Tools Agent v$AgentVersion" -ForegroundColor Green

if (-not (Test-Path $VenvDir)) {
    Invoke-Step "Creating virtualenv at $VenvDir" {
        py -3.12 -m venv $VenvDir
    }
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip    = Join-Path $VenvDir "Scripts\pip.exe"

Invoke-Step "Installing build deps" {
    & $VenvPython -m pip install --upgrade pip wheel setuptools
    & $VenvPip install -r (Join-Path $AgentRoot "requirements.txt")
    & $VenvPip install pyinstaller==6.11.0
}

Invoke-Step "Running PyInstaller" {
    Push-Location $AgentRoot
    try {
        & $VenvPython -m PyInstaller --noconfirm --clean $Spec
    } finally {
        Pop-Location
    }
}

# Locate the freshly-built exe. The spec file's ONE_FILE flag changes
# the layout: one-folder mode (default) writes
# dist\sc2tools-agent\sc2tools-agent.exe alongside an _internal\ deps
# directory; one-file mode writes a single dist\sc2tools-agent.exe.
# Probe both so this script keeps working under either build mode and
# downstream paths (NSIS, signtool) get the right location.
$ExePathFolder = Join-Path $DistDir "sc2tools-agent\sc2tools-agent.exe"
$ExePathSingle = Join-Path $DistDir "sc2tools-agent.exe"
if (Test-Path $ExePathFolder) {
    $ExePath = $ExePathFolder
    $BuildLayout = "one-folder"
} elseif (Test-Path $ExePathSingle) {
    $ExePath = $ExePathSingle
    $BuildLayout = "one-file"
} else {
    throw "PyInstaller did not produce sc2tools-agent.exe in either layout (looked at $ExePathFolder and $ExePathSingle) - check the build log."
}
Write-Host "Build layout: $BuildLayout (exe at $ExePath)" -ForegroundColor DarkGray

if ($Installer) {
    Invoke-Step "Locating makensis" {
        $script:Makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
        if (-not $script:Makensis) {
            $candidate = "C:\Program Files (x86)\NSIS\makensis.exe"
            if (Test-Path $candidate) { $script:Makensis = $candidate }
        }
        if (-not $script:Makensis) {
            throw "makensis not found on PATH. Install NSIS from https://nsis.sourceforge.io/."
        }
    }

    Invoke-Step "Building NSIS installer" {
        & $script:Makensis "/DAGENT_VERSION=$AgentVersion" $Nsi
    }

    $InstallerExe = Join-Path $DistDir "SC2ToolsAgent-Setup-$AgentVersion.exe"
    if (-not (Test-Path $InstallerExe)) {
        throw "NSIS did not emit $InstallerExe."
    }

    if ($SigningCert) {
        Invoke-Step "Code-signing $InstallerExe" {
            $signtool = (Get-Command signtool -ErrorAction SilentlyContinue).Source
            if (-not $signtool) {
                throw "signtool.exe not found on PATH. Install the Windows SDK."
            }
            $password = [System.Environment]::GetEnvironmentVariable($SigningCertPasswordEnv)
            if (-not $password) {
                throw "No signing password in env var '$SigningCertPasswordEnv'."
            }
            & $signtool sign `
                /fd SHA256 `
                /tr $TimestampUrl `
                /td SHA256 `
                /f $SigningCert `
                /p $password `
                $InstallerExe
        }
    }

    Write-Host ""
    Write-Host "Installer:    $InstallerExe" -ForegroundColor Green
    Write-Host "Plain EXE:    $ExePath"      -ForegroundColor Green
    $sha = (Get-FileHash -Algorithm SHA256 $InstallerExe).Hash.ToLower()
    Write-Host "SHA-256:      $sha"           -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Built $ExePath" -ForegroundColor Green
}
