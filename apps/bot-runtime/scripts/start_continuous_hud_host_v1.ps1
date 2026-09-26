# Start only the already-authorized, checkpointed learner, outside terminal jobs.
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $taskRoot
$taskStateFiles = @('runs/build-order-hud-v1/fit-v1/status.json', 'runs/build-order-hud-v1/.trainer.json')
foreach ($taskStateFile in $taskStateFiles) {
    $taskState = Get-Content -Raw -LiteralPath $taskStateFile | ConvertFrom-Json
    $taskExisting = Get-Process -Id $taskState.pid -ErrorAction SilentlyContinue
    if ($null -ne $taskExisting) {
        $taskCreation = ([DateTimeOffset]$taskExisting.StartTime).ToUnixTimeMilliseconds() / 1000.0
        if ([Math]::Abs($taskCreation - [double]$taskState.pid_creation_time) -lt 0.01) {
            [ordered]@{status='already_running';pid=$taskExisting.Id;creation_time=$taskCreation;new_processes=0} | ConvertTo-Json
            exit 0
        }
    }
}
$taskStops = @('STOP','runs/build-order-hud-v1/fit-v1/STOP','runs/build-order-prior-v1/fit619-v1/STOP',
    'runs/own-hud-feature-extraction-v1/data-v1/STOP','runs/player-expansion-contract-review-v1/scoped619-v1/sequences-v2/STOP')
foreach ($taskStop in $taskStops) {
    if (Test-Path -LiteralPath $taskStop) { throw "STOP respected: $taskStop" }
}
$taskRecoveryDir = Join-Path $taskRoot 'runs/build-order-hud-host-v1'
New-Item -ItemType Directory -Path $taskRecoveryDir -Force | Out-Null
$taskStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
Copy-Item -LiteralPath 'runs/build-order-hud-v1/fit-v1/status.json' -Destination (Join-Path $taskRecoveryDir ($taskStamp + '.previous-status.json'))
$taskPython = (Resolve-Path '.venv/Scripts/pythonw.exe').Path
$taskEntry = (Resolve-Path 'scripts/resume_continuous_hud_host_v1.py').Path
$taskStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
$taskCommand = '"' + $taskPython + '" "' + $taskEntry + '"'
$taskCreated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine=$taskCommand; CurrentDirectory=$taskRoot; ProcessStartupInformation=$taskStartup
}
$taskReceipt = [ordered]@{at=[DateTime]::UtcNow.ToString('o');method='Win32_Process.Create';
    return_value=$taskCreated.ReturnValue;created_pid=$taskCreated.ProcessId;show_window=0;
    console_free_pythonw=$true;command=$taskCommand;native_games=0}
$taskReceipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRecoveryDir ($taskStamp + '.windows-launch.json')) -Encoding utf8
$taskReceipt | ConvertTo-Json
if ($taskCreated.ReturnValue -ne 0) { throw "Windows background launch failed: $($taskCreated.ReturnValue)" }
