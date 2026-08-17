[CmdletBinding()]
param(
    [string]$BlenderPath = $env:BLENDER_EXE,
    [string]$M3AddonPath = $env:SC2_M3_ADDON,
    [string]$M3AddonModule = "m3studio",
    [string]$ModelsRoot = $env:SC2_RENDER_MODELS,
    [string]$TexturesRoot = $env:SC2_RENDER_TEXTURES,
    [string]$OutputRoot = (Join-Path $PSScriptRoot "output"),
    [string]$ManifestPath = (Join-Path $PSScriptRoot "render-manifest.json"),
    [string[]]$Spec = @(),
    [switch]$List,
    [switch]$ValidateOnly,
    [switch]$Inspect,
    [switch]$PosterOnly,
    [switch]$AllowUntexturedPreview,
    [switch]$AllowUnsupportedEffects,
    [switch]$Force,
    [switch]$KeepBlend,
    [switch]$DebugBlender
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RequiredFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "$Label was not provided."
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-RequiredDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "$Label was not provided."
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-BlenderExecutable {
    param([string]$RequestedPath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        return Resolve-RequiredFile -Path $RequestedPath -Label "Blender executable"
    }
    $command = Get-Command -Name "blender" -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "Blender was not found. Pass -BlenderPath, set BLENDER_EXE, or add blender to PATH."
    }
    return $command.Source
}

function Assert-AddonPackage {
    param(
        [Parameter(Mandatory = $true)][string]$AddonRoot,
        [Parameter(Mandatory = $true)][string]$ModuleName
    )

    $resolvedRoot = Resolve-RequiredDirectory -Path $AddonRoot -Label "M3 addon path"
    $directInit = Join-Path $resolvedRoot "__init__.py"
    $nestedInit = Join-Path (Join-Path $resolvedRoot $ModuleName) "__init__.py"
    if (Test-Path -LiteralPath $directInit -PathType Leaf) {
        $directName = Split-Path -Leaf $resolvedRoot
        if ($directName -ne $ModuleName) {
            throw "M3 addon package is named '$directName', but -M3AddonModule is '$ModuleName'. Pass -M3AddonModule $directName or point -M3AddonPath at its parent."
        }
        return $resolvedRoot
    }
    if (Test-Path -LiteralPath $nestedInit -PathType Leaf) {
        return $resolvedRoot
    }
    throw "No unpacked addon package was found at '$directInit' or '$nestedInit'. Clone/unpack M3Studio, keep all of its files together, and pass the package directory or its parent with -M3AddonPath."
}

function Get-SafeModelPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Relative,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([IO.Path]::IsPathRooted($Relative)) {
        throw "$Label must be relative to -ModelsRoot, not an absolute path: $Relative"
    }
    $normalizedRelative = $Relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $normalizedRelative))
    $rootWithSeparator = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes -ModelsRoot: $Relative"
    }
    $extension = [IO.Path]::GetExtension($candidate)
    if ($extension -notin @(".m3", ".m3a")) {
        throw "$Label must reference a .m3 or .m3a file: $Relative"
    }
    return $candidate
}

$manifestFull = Resolve-RequiredFile -Path $ManifestPath -Label "Render manifest"
try {
    $manifest = Get-Content -LiteralPath $manifestFull -Raw | ConvertFrom-Json
}
catch {
    throw "Render manifest is not valid JSON: $manifestFull. $($_.Exception.Message)"
}

if ($manifest.schemaVersion -ne 1) {
    throw "Unsupported render manifest schemaVersion '$($manifest.schemaVersion)'; expected 1."
}
if ($null -eq $manifest.specs -or @($manifest.specs).Count -eq 0) {
    throw "Render manifest contains no specs: $manifestFull"
}

$allSpecs = @($manifest.specs)
$duplicateIds = @($allSpecs | Group-Object -Property id | Where-Object { $_.Count -gt 1 })
if ($duplicateIds.Count -gt 0) {
    throw "Render manifest contains duplicate spec ids: $($duplicateIds.Name -join ', ')"
}

if ($List) {
    $allSpecs |
        Select-Object @{ Name = "Id"; Expression = { $_.id } },
            @{ Name = "Delivery"; Expression = { $_.deliveryBaseName } },
            @{ Name = "Frames"; Expression = { $_.frameEnd - $manifest.defaults.frameStart + 1 } },
            @{ Name = "Seconds"; Expression = { [Math]::Round(($_.frameEnd - $manifest.defaults.frameStart + 1) / 24.0, 2) } },
            @{ Name = "Choreography"; Expression = { $_.choreography } },
            @{ Name = "Models"; Expression = { @($_.models).Count } },
            @{ Name = "Label"; Expression = { $_.label } } |
        Format-Table -AutoSize
    return
}

$requiredSpecIds = @(
    "zealot-dance",
    "marine-skyfire",
    "archon-merge",
    "archon-backflip",
    "stalker-blink",
    "carrier-interceptors",
    "zergling-zoomies",
    "baneling-bowling",
    "overlord-party-balloon",
    "battlecruiser-warp-in",
    "mule-money-drop"
)
$knownIds = @($allSpecs | ForEach-Object { [string]$_.id })
$missingRequired = @($requiredSpecIds | Where-Object { $_ -notin $knownIds })
if ($missingRequired.Count -gt 0) {
    throw "Render manifest is missing required choreography specs: $($missingRequired -join ', ')"
}

$requiredRolesByChoreography = @{
    "zealot_dance" = @("hero")
    "marine_skyfire" = @("hero")
    "archon_merge" = @("templar_left", "templar_right", "hero")
    "archon_backflip" = @("hero")
    "stalker_blink" = @("hero")
    "carrier_interceptors" = @("hero")
    "zergling_zoomies" = @("hero")
    "baneling_bowling" = @("hero")
    "overlord_party_balloon" = @("hero")
    "battlecruiser_warp_in" = @("hero")
    "mule_money_drop" = @("hero")
}

if ([string]::IsNullOrWhiteSpace($ModelsRoot)) {
    throw "Models root was not provided. Pass -ModelsRoot or set SC2_RENDER_MODELS to a directory of locally exported M3 models."
}
if ([string]::IsNullOrWhiteSpace($M3AddonPath)) {
    throw "M3 addon path was not provided. Pass -M3AddonPath or set SC2_M3_ADDON to an unpacked M3Studio package (or its parent)."
}

$modelsRootFull = Resolve-RequiredDirectory -Path $ModelsRoot -Label "Models root"
$texturesRootFull = if ([string]::IsNullOrWhiteSpace($TexturesRoot)) {
    $modelsRootFull
}
else {
    Resolve-RequiredDirectory -Path $TexturesRoot -Label "Textures root"
}
$addonRootFull = Assert-AddonPackage -AddonRoot $M3AddonPath -ModuleName $M3AddonModule
$blenderScript = Resolve-RequiredFile -Path (Join-Path $PSScriptRoot "blender_render.py") -Label "Blender Python entrypoint"
$blenderFull = Resolve-BlenderExecutable -RequestedPath $BlenderPath

if ($Spec.Count -eq 0) {
    $selectedSpecs = $allSpecs
}
else {
    $unknown = @($Spec | Where-Object { $_ -notin $knownIds })
    if ($unknown.Count -gt 0) {
        throw "Unknown -Spec value(s): $($unknown -join ', '). Run with -List to see available specs."
    }
    $selectedSpecs = @($allSpecs | Where-Object { $_.id -in $Spec })
}

$missingModels = [Collections.Generic.List[string]]::new()
foreach ($renderSpec in $selectedSpecs) {
    if ($renderSpec.frameEnd -le 1 -or $renderSpec.posterFrame -lt 1 -or $renderSpec.posterFrame -gt $renderSpec.frameEnd) {
        throw "Spec '$($renderSpec.id)' has an invalid frameEnd/posterFrame range."
    }
    if (@($renderSpec.models).Count -eq 0) {
        throw "Spec '$($renderSpec.id)' has no models."
    }
    $roleNames = @($renderSpec.models | ForEach-Object { [string]$_.role })
    $duplicateRoles = @($roleNames | Group-Object | Where-Object { $_.Count -gt 1 })
    if ($duplicateRoles.Count -gt 0) {
        throw "Spec '$($renderSpec.id)' repeats model roles: $($duplicateRoles.Name -join ', ')"
    }
    $choreographyName = [string]$renderSpec.choreography
    if (-not $requiredRolesByChoreography.ContainsKey($choreographyName)) {
        throw "Spec '$($renderSpec.id)' uses unknown choreography '$choreographyName'."
    }
    $missingRoles = @($requiredRolesByChoreography[$choreographyName] | Where-Object { $_ -notin $roleNames })
    if ($missingRoles.Count -gt 0) {
        throw "Spec '$($renderSpec.id)' is missing choreography role(s): $($missingRoles -join ', ')"
    }
    if ($choreographyName -eq "carrier_interceptors" -and @($roleNames | Where-Object { $_ -like "interceptor_*" }).Count -eq 0) {
        throw "Spec '$($renderSpec.id)' requires at least one role named interceptor_1, interceptor_2, etc."
    }
    foreach ($model in @($renderSpec.models)) {
        $label = "$($renderSpec.id) / $($model.role)"
        $modelPath = Get-SafeModelPath -Root $modelsRootFull -Relative ([string]$model.path) -Label $label
        if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
            $missingModels.Add("$label -> $modelPath")
        }
        $animationInputs = if ($null -ne $model.PSObject.Properties["animationPaths"]) {
            @($model.animationPaths)
        }
        else {
            @()
        }
        foreach ($animationInput in $animationInputs) {
            if ($null -eq $animationInput) {
                continue
            }
            if ($animationInput -is [string]) {
                $animationRelative = [string]$animationInput
                $animationOptional = $false
            }
            else {
                $animationRelative = [string]$animationInput.path
                $animationOptional = $animationInput.optional -eq $true
            }
            $animationPath = Get-SafeModelPath -Root $modelsRootFull -Relative $animationRelative -Label "$label native animations"
            if ([IO.Path]::GetExtension($animationPath) -ne ".m3a") {
                throw "$label native-animation path must end in .m3a: $animationRelative"
            }
            if (-not (Test-Path -LiteralPath $animationPath -PathType Leaf)) {
                if ($animationOptional) {
                    Write-Warning "Optional native-animation export is absent for $label`: $animationPath. Main-model actions/root choreography will be used."
                }
                else {
                    $missingModels.Add("$label native animations -> $animationPath")
                }
            }
        }
    }
}

if ($missingModels.Count -gt 0) {
    $details = $missingModels | ForEach-Object { "  - $_" }
    throw "Required M3 inputs are missing:`n$($details -join [Environment]::NewLine)`nExport the models/textures from a locally installed copy into -ModelsRoot while preserving the manifest's relative paths, or edit render-manifest.json to match your exporter layout. No models are downloaded or bundled by this tool."
}

$outputRootFull = [IO.Path]::GetFullPath($OutputRoot)
Write-Host "Validated $($selectedSpecs.Count) render spec(s)." -ForegroundColor Green
Write-Host "  Blender: $blenderFull"
Write-Host "  M3 addon: $addonRootFull (module $M3AddonModule)"
Write-Host "  Models: $modelsRootFull"
Write-Host "  Textures: $texturesRootFull"
Write-Host "  Output: $outputRootFull"

if ($ValidateOnly) {
    Write-Host "Validation only; Blender was not launched." -ForegroundColor Cyan
    return
}

if ($AllowUntexturedPreview -and -not $Inspect) {
    Write-Warning "Primary DDS fidelity enforcement is bypassed. This render is diagnostic-only and must not be packaged or published."
}
if ($AllowUnsupportedEffects -and -not $Inspect) {
    Write-Warning "Unsupported M3 effect-class enforcement is bypassed. This render is calibration-only and must not be packaged or published."
}

if (-not (Test-Path -LiteralPath $outputRootFull -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $outputRootFull
}

foreach ($renderSpec in $selectedSpecs) {
    $specOutput = Join-Path $outputRootFull ([string]$renderSpec.id)
    if ((Test-Path -LiteralPath $specOutput) -and -not $Force -and -not $Inspect) {
        $existingPng = Get-ChildItem -LiteralPath $specOutput -Filter "*.png" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $existingPng) {
            throw "Output already exists for '$($renderSpec.id)' at $specOutput. Choose another -OutputRoot or pass -Force. Existing files are never deleted."
        }
    }

    Write-Host "Rendering $($renderSpec.id): $($renderSpec.label)" -ForegroundColor Cyan
    $blenderArguments = @(
        "--background",
        "--factory-startup",
        "--python-exit-code", "1",
        "--python", $blenderScript,
        "--",
        "--manifest", $manifestFull,
        "--spec", [string]$renderSpec.id,
        "--models-root", $modelsRootFull,
        "--textures-root", $texturesRootFull,
        "--output-root", $outputRootFull,
        "--addon-path", $addonRootFull,
        "--addon-module", $M3AddonModule
    )
    if ($PosterOnly) {
        $blenderArguments += "--poster-only"
    }
    if ($Inspect) {
        $blenderArguments += "--inspect-only"
    }
    if ($AllowUntexturedPreview) {
        $blenderArguments += "--allow-untextured-preview"
    }
    if ($AllowUnsupportedEffects) {
        $blenderArguments += "--allow-unsupported-effects"
    }
    if ($Force) {
        $blenderArguments += "--force"
    }
    if ($KeepBlend) {
        $blenderArguments += "--keep-blend"
    }
    if ($DebugBlender) {
        $blenderArguments += "--debug"
    }

    & $blenderFull @blenderArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Blender failed while rendering '$($renderSpec.id)' with exit code $LASTEXITCODE. Re-run with -DebugBlender for the Python traceback."
    }
}

if ($Inspect) {
    Write-Host "Completed $($selectedSpecs.Count) SC2 M3 inspection report(s)." -ForegroundColor Green
}
else {
    Write-Host "Completed $($selectedSpecs.Count) SC2 alert render(s)." -ForegroundColor Green
}
