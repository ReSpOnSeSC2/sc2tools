[CmdletBinding()]
param(
    [string]$FfmpegPath = $env:FFMPEG_EXE,
    [string]$PythonPath = $env:PYTHON_EXE,
    [string]$InputRoot = (Join-Path $PSScriptRoot "output"),
    [string]$DeliveryRoot = (Join-Path $PSScriptRoot "..\..\apps\web\public\alerts\sc2-3d"),
    [string]$ManifestPath = (Join-Path $PSScriptRoot "render-manifest.json"),
    [string[]]$Spec = @(),
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RequiredFile {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-RequiredDirectory {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-Application {
    param([string]$RequestedPath, [string]$CommandName, [string]$Label)
    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        return Resolve-RequiredFile -Path $RequestedPath -Label $Label
    }
    $command = Get-Command -Name $CommandName -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "$Label was not found. Pass the matching path parameter, set its environment variable, or add $CommandName to PATH."
    }
    return $command.Source
}

$ffmpeg = Resolve-Application -RequestedPath $FfmpegPath -CommandName "ffmpeg" -Label "FFmpeg executable"
$python = Resolve-Application -RequestedPath $PythonPath -CommandName "python" -Label "Python executable"
$manifest = Resolve-RequiredFile -Path $ManifestPath -Label "Render manifest"
$input = Resolve-RequiredDirectory -Path $InputRoot -Label "Rendered input root"
$packager = Resolve-RequiredFile -Path (Join-Path $PSScriptRoot "package_media.py") -Label "Media packager"
$delivery = [IO.Path]::GetFullPath($DeliveryRoot)
$manifestJson = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$knownIds = @($manifestJson.specs | ForEach-Object { [string]$_.id })
if ($Spec.Count -eq 0) {
    $selected = @($knownIds)
}
else {
    $selected = @($Spec)
}
$unknown = @($selected | Where-Object { $_ -notin $knownIds })
if ($unknown.Count -gt 0) {
    throw "Unknown -Spec value(s): $($unknown -join ', ')."
}

if (-not (Test-Path -LiteralPath $delivery -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $delivery
}

foreach ($id in $selected) {
    Write-Host "Packaging $id" -ForegroundColor Cyan
    $arguments = @(
        $packager,
        "--manifest", $manifest,
        "--spec", $id,
        "--input-root", $input,
        "--delivery-root", $delivery,
        "--ffmpeg", $ffmpeg
    )
    if ($Force) {
        $arguments += "--force"
    }
    & $python @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Media packaging failed for '$id' with exit code $LASTEXITCODE."
    }
}

Write-Host "Packaged $($selected.Count) SC2 alert media set(s) into $delivery." -ForegroundColor Green
