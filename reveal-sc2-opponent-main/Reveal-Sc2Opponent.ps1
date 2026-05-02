<#PSScriptInfo
.VERSION 0.9.5
.GUID db8ffc68-4388-4119-b437-1f56c999611e
.AUTHOR nephestdev@gmail.com (Modified by Gemini)
.DESCRIPTION 
 Reveals ranked 1v1 opponent names for StarCraft2 and tracks Head-to-Head history.
 v0.9.5 - Auto-detect active server by probing Pulse for opponent name in each user-team region (matchmaking is single-region, so where the opponent is found = the server we're on). Works instantly when user switches regions, beats Pulse ingestion lag. v0.9.4 fixed unwrap bug. v0.9.3 added recently-active anchor. v0.9.0 removed OCR.
#> 
param(
    [int64[]]$CharacterId,
    [string]$PlayerName,
    [ValidateSet("terran", "protoss", "zerg", "random")]
    [string]$Race,
    [ValidateRange(1, 10)]
    [int32]$Limit = 3,
    [ValidateRange(1, 10000)]
    [int32]$LastPlayedAgoMax = 2400,
    [ValidateSet("us", "eu", "kr", "cn")]
    [string[]]$ActiveRegion = @("us", "eu", "kr"),
    [string]$FilePath,
    [switch]$Notification,
    [ValidateSet("none", "short", "long")]
    [string]$RatingFormat = "none",
    [ValidateSet("none", "short", "long")]
    [string]$RaceFormat = "none",
    [string]$Separator = "`r`n",
    [switch]$DisableQuickEdit,
    [switch]$SelectProfile,
    [switch]$Test
)

# --- CONFIGURATION FOR HISTORY ---
# Canonical Black Book path. The Python data layer (core.paths.HISTORY_FILE)
# and the Node backend (pickHistoryPath -> data/) both anchor to data/.
# Earlier versions of this script wrote to the project root, which let the
# Black Book drift (PS-side updates never reached the data/ copy that the
# overlay actually reads). We now write to the same data/ location. We
# still fall back to the project-root path if data/ doesn't exist yet --
# that supports clean checkouts where the data/ folder hasn't been
# materialised by the migration code.
$DataDirHistoryPath = Join-Path $PSScriptRoot "data\MyOpponentHistory.json"
$LegacyHistoryPath  = Join-Path $PSScriptRoot "MyOpponentHistory.json"
$DataDir = Join-Path $PSScriptRoot "data"
if (-not (Test-Path -LiteralPath $DataDir)) {
    try { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null } catch {}
}
$HistoryFilePath = if (Test-Path -LiteralPath (Split-Path -Parent $DataDirHistoryPath)) {
    $DataDirHistoryPath
} else {
    $LegacyHistoryPath
}
$IdlePollInterval    = 0.5   
$InGamePollInterval  = 0.5   
# When the SC2 client API on port 6119 is unreachable (game not
# launched yet) we slow the poll to once every 2s. Avoids hammering
# localhost and stops the console from spamming connection errors.
$IdlePollIntervalNoSc2 = 2.0
# ---------------------------------

# Sc2PulseApiRoot is needed before the Pulse name-search block. It is
# defined again later (kept there as the canonical declaration); declaring
# it twice is harmless because it is the same constant.
$Sc2PulseApiRoot_Bootstrap = "https://sc2pulse.nephest.com/sc2/api"

if ($null -eq $CharacterId -or $CharacterId.Length -eq 0) {
    if (-not [string]::IsNullOrWhiteSpace($PlayerName)) {
        Write-Host "Resolving Pulse character IDs for player name: $PlayerName ..." -ForegroundColor Cyan
        $ResolvedIds = New-Object System.Collections.Generic.HashSet[int64]
        # Hit the latest season per region -- Pulse needs a season for the
        # advanced character search. If the player is on multiple regions
        # (NA + EU, etc.) we collect IDs from each.
        try {
            $Seasons = (Invoke-RestMethod -Uri "${Sc2PulseApiRoot_Bootstrap}/season/list/all") |
                Group-Object -Property Region -AsHashTable
            $LatestPerRegion = $Seasons.Values |
                ForEach-Object { $_ | Select-Object -First 1 } |
                Where-Object { @("US","EU","KR","CN") -contains $_.Region }
        } catch {
            Write-Host "Pulse season lookup failed: $_" -ForegroundColor Red
            $LatestPerRegion = @()
        }
        foreach ($Season in $LatestPerRegion) {
            $EncodedName = [uri]::EscapeDataString($PlayerName)
            $Region = $Season.Region.ToUpper()
            $Uri = "${Sc2PulseApiRoot_Bootstrap}/character/search/advanced?season=$($Season.BattlenetId)&region=${Region}&queue=LOTV_1V1&name=${EncodedName}&caseSensitive=true"
            try {
                $Found = Invoke-RestMethod -Uri $Uri
                foreach ($id in $Found) {
                    if ($id -as [int64]) { $null = $ResolvedIds.Add([int64]$id) }
                }
            } catch {
                # Per-region miss is normal -- player may not exist on every region.
            }
        }
        if ($ResolvedIds.Count -gt 0) {
            $CharacterId = @($ResolvedIds)
            Write-Host "Resolved $($CharacterId.Length) Pulse character IDs for ${PlayerName}: $($CharacterId -join ', ')" -ForegroundColor Green
        } else {
            Write-Host "Pulse name search returned no matches for ${PlayerName}." -ForegroundColor Red
            Write-Host "Find your ID at https://sc2pulse.nephest.com/sc2/?#search and set -CharacterId or SC2_CHARACTER_IDS." -ForegroundColor Red
            exit
        }
    } else {
        Write-Host "ERROR: No -CharacterId or -PlayerName provided." -ForegroundColor Red
        Write-Host "Set SC2_CHARACTER_IDS (Pulse IDs) or SC2_PLAYER_NAME in reveal-sc2-opponent.bat." -ForegroundColor Red
        Write-Host "Find your Pulse ID at https://sc2pulse.nephest.com/sc2/?#search" -ForegroundColor Red
        Write-Host "(NOTE: Local SC2 folder IDs like "1-S2-1-267727" are NOT Pulse IDs.)" -ForegroundColor Yellow
        exit
    }
}

# --- Identity pattern --------------------------------------------------
# Earlier versions of this script hardcoded the player handle as
# (?i)ReSpOnSe in the "who's me?" regex used by Get-MyResult and the
# live opponent-detection block. That broke for every other user. We
# now derive the pattern from -PlayerName when supplied; if it's blank
# we fall back to looking up character names from Pulse for each
# resolved $CharacterId so the regex still has a real signal to match.
$Script:MyNamePattern = $null
if (-not [string]::IsNullOrWhiteSpace($PlayerName)) {
    $Script:MyNamePattern = "(?i)" + [regex]::Escape($PlayerName)
} else {
    $NameParts = New-Object System.Collections.Generic.HashSet[string]
    foreach ($CharId in $CharacterId) {
        try {
            $CharInfo = Invoke-RestMethod -Uri "${Sc2PulseApiRoot_Bootstrap}/character/${CharId}"
            $RawName = $null
            if ($null -ne $CharInfo.members -and $null -ne $CharInfo.members.character) {
                $RawName = $CharInfo.members.character.name
            } elseif ($null -ne $CharInfo.character) {
                $RawName = $CharInfo.character.name
            }
            if (-not [string]::IsNullOrWhiteSpace($RawName)) {
                # Pulse names look like "Name#1234" -- the in-game name
                # the SC2 client API returns is just the part before #.
                $Stripped = ($RawName -split '#')[0]
                if (-not [string]::IsNullOrWhiteSpace($Stripped)) {
                    $null = $NameParts.Add($Stripped)
                }
            }
        } catch {
            # Per-id miss is fine; we just need at least one match.
        }
    }
    if ($NameParts.Count -gt 0) {
        $EscapedParts = $NameParts | ForEach-Object { [regex]::Escape($_) }
        $Script:MyNamePattern = "(?i)(" + ($EscapedParts -join '|') + ")"
        Write-Host "Derived player-name pattern from Pulse: $Script:MyNamePattern" -ForegroundColor DarkGray
    }
}
if ([string]::IsNullOrWhiteSpace($Script:MyNamePattern)) {
    Write-Host "WARNING: could not derive a player-name pattern; opponent detection may misclassify players." -ForegroundColor Yellow
    # Match-nothing pattern -- safer than a stale hardcoded handle.
    $Script:MyNamePattern = "(?!x)x"
}

# Publish the resolved Character IDs to a shared file at the project
# root so the Node overlay backend (and any other component) can read
# them without re-implementing the auto-detect. Single source of truth:
# this script. Override by passing -CharacterId from reveal-sc2-opponent.bat.
try {
    $CharacterIdsPath = Join-Path $PSScriptRoot "character_ids.txt"
    [string]::Join(',', $CharacterId) | Out-File -FilePath $CharacterIdsPath -Encoding ascii -NoNewline
    Write-Host "Published Character IDs to: $CharacterIdsPath" -ForegroundColor DarkGray
} catch {
    Write-Host "Warning: failed to write character_ids.txt: $_" -ForegroundColor Yellow
}

if($DisableQuickEdit) {
    Add-Type -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int mode);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr GetStdHandle(int handle);
"@ -Namespace Win32 -Name NativeMethods
    $Handle = [Win32.NativeMethods]::GetStdHandle(-10)
    [Win32.NativeMethods]::SetConsoleMode($Handle, 0x0080)
}

Test-ScriptFileInfo $PSCommandPath
Add-Type -AssemblyName Microsoft.PowerShell.Commands.Utility

if(-not [string]::IsNullOrEmpty($FilePath)) {
    if(Test-Path -Path $FilePath) { Clear-Content -Path $FilePath } 
    else { New-Item -Path $FilePath -ItemType File }
}

$Sc2PulseApiRoot = "https://sc2pulse.nephest.com/sc2/api"
$Sc2ClientApiRoot = "http://127.0.0.1:6119"
$Queue1v1 = "LOTV_1V1"
$ValidPlayerCount = if($Test) { 1 } else { 2 }
if(-not [string]::IsNullOrEmpty($Race)) { $Race = $Race.ToUpper() }

enum GameStatus { New; Old; None; Unsupported }
enum OutFormat { None; Short; Long }

$CurrentGame = [PSCustomObject]@{
    IsReplay = $false
    DisplayTime = 999999
    Players = @()
    ActivePlayerCount = 0
    Status = [GameStatus]::Old
    Finished = $true
}

if($Notification) {
    $ToastAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    $ToastNotifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($ToastAppId)
}
$TeamBatchSize = 200
$OverrideTeam = -1

function ConvertTo-DeepHashtable {
    param([Parameter(ValueFromPipeline=$true)]$InputObject)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IList]) {
        $Result = [System.Collections.ArrayList]::new()
        foreach ($Item in $InputObject) { [void]$Result.Add((ConvertTo-DeepHashtable $Item)) }
        return @(,$Result.ToArray())
    }
    if ($InputObject -is [PSCustomObject]) {
        $Hash = @{}
        $InputObject.PSObject.Properties | ForEach-Object { $Hash[$_.Name] = ConvertTo-DeepHashtable $_.Value }
        return $Hash
    }
    return $InputObject
}

function Get-History {
    if (Test-Path $HistoryFilePath) {
        try {
            $Content = Get-Content $HistoryFilePath -Raw
            if ([string]::IsNullOrWhiteSpace($Content)) { return @{} }
            $JsonObj = $Content | ConvertFrom-Json
            $HistoryHash = @{}
            if ($JsonObj) {
                $JsonObj.PSObject.Properties | ForEach-Object { $HistoryHash[$_.Name] = ConvertTo-DeepHashtable $_.Value }
            }
            return $HistoryHash
        } catch { return @{} }
    }
    return @{}
}

# Atomic write helper -- prevents partial writes if the process is killed
# mid-flush. Writes to a sibling temp file in the same directory then
# atomically renames into place. Mirrors `core.atomic_io.atomic_write_json`
# on the Python side and `_atomicWriteJsonSync` on the Node side.
#
# Background: PowerShell's default `Set-Content` / `Out-File` / even
# `WriteAllText` are NOT atomic. If the script is killed (Ctrl-C, machine
# sleep, process tree teardown when SC2 quits, etc.) while writing 2-4 MB
# of opponent history we end up with an unclosed-brace JSON file that
# `analyzer.js` then refuses to parse. The tmp + Move-Item dance below
# guarantees the destination file is either fully-written-good or
# untouched -- never half-written.
function Write-FileAtomic {
    param(
        [Parameter(Mandatory)] [string] $TargetPath,
        [Parameter(Mandatory)] [string] $Content,
        [System.Text.Encoding] $Encoding = [System.Text.Encoding]::UTF8
    )
    $dir = Split-Path -Parent $TargetPath
    if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = Join-Path $dir (".tmp_" + [Guid]::NewGuid().ToString("N") + ".json")
    $fs = $null
    try {
        # `WriteAllText` returns as soon as the bytes hit the OS write cache,
        # NOT when they are durable on disk. On Windows NTFS the lazy writer
        # can defer the actual data flush by several seconds. If the process
        # is killed (Ctrl-C, machine sleep, SC2 quit tearing down the tree,
        # AV scan, OneDrive sync collision, etc.) between the rename and the
        # lazy flush, the destination file is left with only the bytes the
        # OS happened to have written -- a half-written JSON whose final
        # closing brace is missing. That's the truncation mode that's been
        # corrupting MyOpponentHistory.json roughly weekly.
        #
        # FileStream + Flush(true) calls FlushFileBuffers under the hood,
        # which is the Win32 equivalent of POSIX fsync(). This forces every
        # cached byte to durable storage BEFORE we publish the rename, so a
        # kill at any point either leaves the original file untouched or
        # the destination file fully-written. Mirrors what the Python
        # (core/atomic_io.py) and Node (analyzer.js persistMetaDb) writers
        # already do.
        $bytes = $Encoding.GetBytes($Content)
        $fs = [System.IO.FileStream]::new(
            $tmp,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $fs.Write($bytes, 0, $bytes.Length)
        # `Flush($true)` -> calls FlushFileBuffers. Without the boolean arg
        # the .NET Flush only nudges the runtime buffer to the OS cache,
        # which is exactly the behaviour we are trying to escape.
        $fs.Flush($true)
        $fs.Close()
        $fs = $null
        # Move-Item -Force calls MoveFileEx with REPLACE_EXISTING, which is
        # atomic on NTFS. The earlier fsync guarantees the temp file's data
        # blocks are durable before this rename publishes them.
        Move-Item -LiteralPath $tmp -Destination $TargetPath -Force
    } catch {
        if ($null -ne $fs) {
            try { $fs.Close() } catch {}
        }
        if (Test-Path -LiteralPath $tmp) {
            try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch {}
        }
        throw
    }
}

function Save-History {
    param($HistoryData)
    # Windows PowerShell 5.1's ConvertTo-Json is notoriously memory-hungry
    # on large nested object graphs -- it builds an intermediate parse
    # tree that grows roughly quadratically with input size and OOMs
    # ('System.OutOfMemoryException') once MyOpponentHistory grows past a
    # few MB. Serialising the top-level dictionary entry-by-entry keeps
    # every ConvertTo-Json call scoped to a single small opponent record
    # (a few KB at most), which fits comfortably in memory regardless of
    # how many opponents the file accumulates.
    #
    # Output shape is unchanged at the JSON level: a top-level object
    # mapping the same keys to the same values. The only cosmetic
    # difference is that each opponent record is written on a single
    # compact line instead of pretty-printed across many. Entry
    # boundaries still end in '},\n' so the salvage path in
    # stream-overlay-backend/index.js (_salvageJsonObject) can still
    # recover the file if a write is ever interrupted.
    if ($null -eq $HistoryData) { $HistoryData = @{} }
    if (-not ($HistoryData -is [System.Collections.IDictionary])) {
        throw "Save-History: expected hashtable, got $($HistoryData.GetType().FullName)"
    }
    $sb = [System.Text.StringBuilder]::new(8192)
    [void]$sb.Append('{')
    [void]$sb.Append([Environment]::NewLine)
    $first = $true
    foreach ($key in $HistoryData.Keys) {
        if (-not $first) {
            [void]$sb.Append(',')
            [void]$sb.Append([Environment]::NewLine)
        }
        $first = $false
        # Compact-serialise each opponent record on its own. -Depth 100
        # is a generous ceiling -- real records are 4-5 levels deep
        # (oppId -> Matchups -> matchup -> Games -> game.field) plus
        # build_log arrays of strings, so 100 is far above any realistic
        # depth while still bounding runaway recursion if the dictionary
        # is somehow self-referential.
        $entry = $HistoryData[$key]
        $entryJson = $entry | ConvertTo-Json -Depth 100 -Compress
        # ConvertTo-Json on a bare string emits a properly quoted +
        # escaped JSON string (e.g. handles backslashes, control chars,
        # unicode). Safer than rolling our own quote-escaper here.
        $keyJson = ConvertTo-Json -InputObject ([string]$key) -Compress
        [void]$sb.Append('    ')
        [void]$sb.Append($keyJson)
        [void]$sb.Append(': ')
        [void]$sb.Append($entryJson)
    }
    [void]$sb.Append([Environment]::NewLine)
    [void]$sb.Append('}')
    [void]$sb.Append([Environment]::NewLine)
    $Json = $sb.ToString()
    # Atomic write: tmp + rename. Survives a mid-write kill without
    # leaving a half-written file on disk.
    Write-FileAtomic -TargetPath $HistoryFilePath -Content $Json -Encoding ([System.Text.Encoding]::UTF8)
}

function Update-OpponentHistory {
    param([string]$OpponentId, [string]$OpponentName, [string]$MyResult, [string]$MapName, [string]$MyRace, [string]$OpponentRace)
    # Random-race opponents and offline games come through with no
    # SC2Pulse Character ID. Fall back to a synthetic "unknown:<Name>"
    # key so we still record the game under the SAME key the Python
    # deep-parse watcher uses (watchers/replay_watcher.py:375). The
    # identity-aware upsert in core/data_store.py prevents the two
    # writers from double-counting when both fire.
    if ([string]::IsNullOrEmpty($OpponentId)) {
        if ([string]::IsNullOrEmpty($OpponentName)) { return }
        $CleanName = $OpponentName
        if ($CleanName.Contains("]")) { $CleanName = ($CleanName.Split("]")[-1]).Trim() }
        $OpponentId = "unknown:" + $CleanName
    }

    $History = Get-History
    if (-not $History.ContainsKey($OpponentId)) { $History[$OpponentId] = @{ "Name" = $OpponentName; "Matchups" = @{} } }
    if (-not $History[$OpponentId].ContainsKey("Matchups")) { $History[$OpponentId]["Matchups"] = @{} }

    $History[$OpponentId]["Name"] = $OpponentName
    $MatchupString = "$($MyRace.ToUpper())v$($OpponentRace.ToUpper())"

    if (-not $History[$OpponentId]["Matchups"].ContainsKey($MatchupString)) {
        $History[$OpponentId]["Matchups"][$MatchupString] = @{ "Wins" = 0; "Losses" = 0; "Games" = @() }
    }

    if ($MyResult -eq "Victory") {
        $History[$OpponentId]["Matchups"][$MatchupString]["Wins"] = [int]$History[$OpponentId]["Matchups"][$MatchupString]["Wins"] + 1
    } elseif ($MyResult -eq "Defeat") {
        $History[$OpponentId]["Matchups"][$MatchupString]["Losses"] = [int]$History[$OpponentId]["Matchups"][$MatchupString]["Losses"] + 1
    }

    $NewGameLog = @{ "Date" = (Get-Date).ToString("yyyy-MM-dd HH:mm"); "Result" = $MyResult; "Map" = $MapName }
    $UpdatedGames = @()
    if ($History[$OpponentId]["Matchups"][$MatchupString].Games -and $History[$OpponentId]["Matchups"][$MatchupString].Games.Count -gt 0) {
        $UpdatedGames = @($History[$OpponentId]["Matchups"][$MatchupString].Games)
    }
    $UpdatedGames += ,$NewGameLog
    $History[$OpponentId]["Matchups"][$MatchupString]["Games"] = $UpdatedGames

    Save-History -HistoryData $History
    
    $MyInitial = if ($MyRace -and $MyRace.Length -gt 0) { $MyRace.Substring(0,1).ToUpper() } else { "U" }
    $OppInitial = if ($OpponentRace -and $OpponentRace.Length -gt 0) { $OpponentRace.Substring(0,1).ToUpper() } else { "U" }
    
    Write-Host " [Black Book] Updated ${MyInitial}v${OppInitial} record vs $OpponentName. Result: $MyResult" -ForegroundColor Cyan
}

function Get-OpponentRecord {
    param([string]$OpponentId, [string]$MyRace, [string]$OpponentRace)
    if ([string]::IsNullOrEmpty($OpponentId)) { return $null }
    $History = Get-History
    $MatchupString = "$($MyRace.ToUpper())v$($OpponentRace.ToUpper())"
    if ($History.ContainsKey($OpponentId)) {
        if ($History[$OpponentId].ContainsKey("Matchups") -and $History[$OpponentId]["Matchups"].ContainsKey($MatchupString)) {
            return $History[$OpponentId]["Matchups"][$MatchupString]
        }
    }
    return $null
}

function Get-MyResult {
    param([Object[]]$Players)
    $Me = $Players | Where-Object { $_.Type -ne "computer" -and $_.Name -match $Script:MyNamePattern } | Select-Object -First 1
    if ($null -eq $Me) { return $null }
    if ($Me.result -ne "Undecided" -and -not [string]::IsNullOrEmpty($Me.result)) { return $Me.result }
    return $null
}

function Invoke-EnhancedRestMethod {
    param(
        [Microsoft.PowerShell.Commands.WebRequestMethod]$Method = [Microsoft.PowerShell.Commands.WebRequestMethod]::Get,
        [string]$Uri,
        [Object]$Body,
        [System.Text.Encoding]$Encoding = [system.Text.Encoding]::UTF8,
        [System.Net.HttpStatusCode[]]$ValidResponseCodes = @([System.Net.HttpStatusCode]::OK, [System.Net.HttpStatusCode]::NotFound),
        # Suppress the per-request [API Details] body print. Used by the
        # SC2 client poll, which routinely returns 404 / connection-refused
        # when SC2 is at the menu or not launched yet -- spamming those
        # to the console every 500ms drowns out real status messages.
        [switch]$Quiet
    )
    $ProgressPreference = 'SilentlyContinue';
    $Response = try { (Invoke-WebRequest -UseBasicParsing -Method $Method -Uri $Uri -Body $Body) }  catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            try {
                $Stream = $_.Exception.Response.GetResponseStream()
                $Reader = New-Object System.IO.StreamReader($Stream)
                $ErrBody = $Reader.ReadToEnd()
                if (-not [string]::IsNullOrWhiteSpace($ErrBody) -and -not $Quiet) {
                    Write-Host " [API Details] $ErrBody" -ForegroundColor Yellow
                }
            } catch {}
        }
        if(-not ($ValidResponseCodes -contains $_.Exception.Response.StatusCode)) { throw $_.Exception }
    }
    $ProgressPreference = 'Continue';
    if([string]::IsNullOrEmpty($Response)) { return }
    return $Encoding.GetString($Response.RawContentStream.ToArray()) | ConvertFrom-Json
}

function Is-Fake-Tag { param([string]$Tag) return $Tag.StartsWith("f#"); }
function Is-Barcode() { param([string]$PlayerName) return $PlayerName -match '^[IiLl]+#\d+$' }

function Format-Race {
    param([string]$Race, [OutFormat]$RaceFormat)
    if ([string]::IsNullOrEmpty($Race)) { return "" }
    return $(switch($RaceFormat) { Short { $Race.Substring(0, 1).toUpper() }; Long { $Race.toLower() } })
}

function Get-TeamMemberRace {
    param([Object] $TeamMember)
    $Race = $null; $Games = 0
    $PossibleRaces = @("TERRAN", "PROTOSS", "ZERG", "RANDOM")
    foreach($CurRace in $PossibleRaces) {
        $CurGames = $TeamMember."${CurRace}GamesPlayed"
        if($CurGames -gt $Games) { $Race = $CurRace; $Games = $CurGames }
    }
    return $Race
}

function Get-TeamRace {
    param([Object] $Team)
    if($Team.Members.Length -ne 1) { return $null }
    return Get-TeamMemberRace $Team.Members[0]
}

function Unmask-Player {
    param([Object]$Player)
    $UnmaskedPlayer = if([string]::IsNullOrEmpty($Player.ProNickname)) {
        if(-not (Is-Fake-Tag -Tag $Player.Account.BattleTag) -and (Is-Barcode -PlayerName $Player.Character.Name)) { $Player.Account.BattleTag } 
        else { $Player.Character.Name }                
    } else {
        if(-not [string]::IsNullOrEmpty($Player.ProTeam)) { "[$($Player.ProTeam)]$($Player.ProNickname)" } else { $Player.ProNickname }
    }
    return $UnmaskedPlayer
}

function Unmask-Team {
    param([Object] $Team, [OutFormat] $RatingFormat, [OutFormat] $RaceFormat)
    $Unmasked = Unmask-Player -Player $Team.Members[0];
    switch($RatingFormat) {
        Short { $Unmasked += " " + $Team.Rating }
        Long { $Unmasked += " " + $Team.Rating + "MMR" }
    }
    $TeamRaceStr = Get-TeamRace $Team
    if($RaceFormat -ne [OutFormat]::None -and -not [string]::IsNullOrEmpty($TeamRaceStr)) { 
        $Unmasked += " " + (Format-Race -Race $TeamRaceStr -RaceFormat $RaceFormat) 
    }
    return $Unmasked
}

function Unmask-GameOpponent {
    param([Object] $GameOpponent, [string] $OpponentRace, [OutFormat] $RaceFormat)
    $Unmasked = $GameOpponent.Name
    if($RaceFormat -ne [OutFormat]::None -and -not [string]::IsNullOrEmpty($OpponentRace)) { 
        $Unmasked += " " + (Format-Race -Race $OpponentRace -RaceFormat $RaceFormat) 
    }
    return $Unmasked
}

function Get-Game {
    param([Object] $CurrentGame, [int32] $ValidPlayerCount)
    # SC2 client API at 127.0.0.1:6119 is only available while SC2.exe
    # is running. When the user launches this script before SC2, every
    # poll either gets connection-refused (no listener) or a 404 from
    # whatever owns the port. Both used to spam the console; now we
    # treat them as "SC2 not running", print a one-shot waiting
    # message, and silently retry until SC2 comes up. The instant SC2
    # starts answering we flip the flag, log a single "detected"
    # line, and the rest of the loop proceeds as before -- so no
    # restart is needed when SC2 is launched mid-run.
    $Game = $null
    try {
        $Game = Invoke-EnhancedRestMethod -Uri "${Sc2ClientApiRoot}/game" -Quiet
    } catch [System.Net.WebException] {
        # Connect-refused / no listener -- SC2.exe is not running.
        if ($Script:Sc2ClientReachable) {
            $Script:Sc2ClientReachable = $false
            Write-Host " [SC2] Client API unreachable -- waiting for StarCraft II to launch..." -ForegroundColor DarkYellow
            $Script:Sc2ClientLastWarn = [DateTime]::Now
        } elseif (([DateTime]::Now - $Script:Sc2ClientLastWarn).TotalSeconds -ge 30) {
            $Script:Sc2ClientLastWarn = [DateTime]::Now
            Write-Host " [SC2] Still waiting for StarCraft II..." -ForegroundColor DarkGray
        }
        return
    }
    # A response shaped like the SC2 client payload (has a Players
    # property, even when empty) means SC2 is reachable. A bare $null
    # from a quiet 404 means *something* is on port 6119 but it isn't
    # SC2's UI server -- treat that as not reachable too.
    $LooksLikeSc2 = $null -ne $Game -and $null -ne $Game.PSObject.Properties['Players']
    if ($LooksLikeSc2) {
        if (-not $Script:Sc2ClientReachable) {
            $Script:Sc2ClientReachable = $true
            Write-Host " [SC2] Client API reachable -- ready for games" -ForegroundColor Green
        }
    } else {
        if ($Script:Sc2ClientReachable) {
            $Script:Sc2ClientReachable = $false
            Write-Host " [SC2] Client API stopped responding -- waiting for StarCraft II..." -ForegroundColor DarkYellow
            $Script:Sc2ClientLastWarn = [DateTime]::Now
        } elseif (([DateTime]::Now - $Script:Sc2ClientLastWarn).TotalSeconds -ge 30) {
            $Script:Sc2ClientLastWarn = [DateTime]::Now
            Write-Host " [SC2] Still waiting for StarCraft II..." -ForegroundColor DarkGray
        }
        return
    }
    if($Game -eq $null) { return }
    
    $ActivePlayerCount = ($Game.Players | Where {$_.result -eq "undecided"} | Measure-Object).Count
    Add-Member -InputObject $Game -Name ActivePlayerCount -Value $ActivePlayerCount -MemberType NoteProperty
    $Finished = $Game -eq $null -or $Game.Players.Length -eq 0 -or $Game.ActivePlayerCount -le $Game.Players.Length / 2
    Add-Member -InputObject $Game -Name Finished -Value $Finished -MemberType NoteProperty
    
    $Status = if($Game.Players.Length -eq 0) { [GameStatus]::None } else { 
        if($Game.isReplay -or ($Game.Players | Where {$_.type -eq "user"} | Measure-Object).Count -ne $ValidPlayerCount) { [GameStatus]::Unsupported } 
        else {
            if(-not $CurrentGame.isReplay -and $Game.Players.Length -eq $CurrentGame.Players.Length -and $Game.DisplayTime -ge $CurrentGame.DisplayTime -and $Game.ActivePlayerCount -le $CurrentGame.ActivePlayerCount) { [GameStatus]::Old } 
            else { [GameStatus]::New }            
        }
    }
    Add-Member -InputObject $Game -Name Status -Value $Status -MemberType NoteProperty
    return $Game
}

function Get-Team {
    param([int32] $Season, [string] $Race, [string] $Queue, [int64] $TeamId = -1, [int64[]] $CharacterId)
    $CharacterTeams = @()
    for(($i = 0); $i -lt $CharacterId.Length;) {
        $EndIx = [Math]::Min($i + $Script:TeamBatchSize - 1, $CharacterId.Length - 1);
        $CharacterIdBatch = $CharacterId[$i..$EndIx]
        $RaceParam = if ([string]::IsNullOrEmpty($Race)) { "" } else { "&race=$Race" }
        $CharacterTeams += Invoke-EnhancedRestMethod -Uri ("${Sc2PulseApiRoot}/group/team?season=${Season}&queue=${Queue}${RaceParam}&characterId=$([String]::Join(',', $CharacterIdBatch))")
        $i += $Script:TeamBatchSize
    }
    if($TeamId -ne -1) { $CharacterTeams = $CharacterTeams | Where-Object {$_.Id -eq $TeamId} }
    return $CharacterTeams
}

function Get-OpponentTeams {
    # v0.9.1 -- OCR removed. Opponent matching anchors RatingDelta
    # against the player's MAIN SC2Pulse team (selected by most games
    # played this season; see Find-PlayerProfile) with a tight cap
    # (RATING_DELTA_CAP_MMR). When no team falls inside the band we
    # fall back to the most-recently-played team that name-matches.
    param(
        [Object] $GameOpponent,
        [int32] $Season,
        [string] $Race,
        [string] $Queue,
        [int32] $LastPlayedAgoMax,
        [int32] $Limit,
        [string] $Region,
        [int32] $PlayerRating = 0
    )

    $RATING_DELTA_CAP_MMR = 400

    $SafeRegion = $Region.ToUpper()
    $EncodedName = [uri]::EscapeDataString($GameOpponent.Name)
    $OpponentIds = $(Invoke-EnhancedRestMethod -Uri ("${Sc2PulseApiRoot}/character/search/advanced?season=${Season}&region=${SafeRegion}&queue=${Queue}&name=${EncodedName}&caseSensitive=true"))

    if($OpponentIds.Length -eq 0) { return }

    $OpponentTeams = Get-Team -Season $Season -Queue $Queue -Race $Race -CharacterId $OpponentIds
    $Now = [DateTimeOffset]::Now

    foreach($Team in $OpponentTeams) {
        $LastPlayedParsed = [DateTimeOffset]::Parse($Team.LastPlayed, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $LastPlayedAgo = $Now.Subtract($LastPlayedParsed).TotalSeconds
        Add-Member -InputObject $Team -Name LastPlayedAgo -Value $LastPlayedAgo -MemberType NoteProperty -Force

        if ($PlayerRating -gt 0) {
            $RatingDelta = [Math]::Abs($Team.Rating - $PlayerRating)
            Add-Member -InputObject $Team -Name RatingDelta -Value $RatingDelta -MemberType NoteProperty -Force
        }
    }

    # Diagnostic: show every candidate the SC2Pulse name-search returned
    # so you can spot when an alt account with the same name is winning.
    if ($PlayerRating -gt 0) {
        Write-Host (" [Pulse] Opponent search anchored at {0} MMR (band +/-{1}):" -f `
            $PlayerRating, $RATING_DELTA_CAP_MMR) -ForegroundColor DarkCyan
        foreach ($Team in $OpponentTeams) {
            $InBand = if ($Team.RatingDelta -le $RATING_DELTA_CAP_MMR) { "IN-BAND " } else { "out-band" }
            $Name = if ($Team.Members -and $Team.Members[0].Character) { $Team.Members[0].Character.Name } else { "?" }
            Write-Host ("   {0} {1,-30} {2,4} MMR  delta={3,4}  lastPlayed={4,5}s" -f `
                $InBand, $Name, $Team.Rating, $Team.RatingDelta, [int32]$Team.LastPlayedAgo) -ForegroundColor DarkCyan
        }
    }

    # Barcode opponents (e.g., "IIIIIIIIIIII#33636") all share the same
    # literal in-game name across many accounts. MMR distance picks the
    # closest, but with identical names that frequently selects the wrong
    # account when a band has multiple candidates. Strategy:
    #   1. Filter to candidates inside the +/- RATING_DELTA_CAP_MMR band.
    #   2. Among those, prefer the most-recently-played (Pulse may still
    #      be a few hours stale, but recency *within the band* is a much
    #      better disambiguator than MMR-distance among same-name accounts).
    #   3. If nothing is in band, fall back to recently-active overall
    #      (last 1h), then to the broader recency search.
    $BARCODE_RECENCY_SECONDS = 3600
    $IsBarcodeOpp = (Is-Barcode -PlayerName $GameOpponent.Name)
    if ($IsBarcodeOpp) {
        if ($PlayerRating -gt 0) {
            $InBand = @($OpponentTeams | Where-Object { $_.RatingDelta -le $RATING_DELTA_CAP_MMR })
            if ($InBand.Count -gt 0) {
                Write-Host (" [Pulse] Barcode opponent -> in-band ({0}) sorted by recency" -f `
                    $InBand.Count) -ForegroundColor DarkCyan
                return ($InBand | Sort-Object -Property LastPlayedAgo | Select-Object -First $Limit)
            }
        }
        $RecentBarcodes = @($OpponentTeams | Where-Object { $_.LastPlayedAgo -le $BARCODE_RECENCY_SECONDS })
        if ($RecentBarcodes.Count -gt 0) {
            Write-Host (" [Pulse] Barcode opponent -> no in-band match; recency wins ({0} within {1}s)" -f `
                $RecentBarcodes.Count, $BARCODE_RECENCY_SECONDS) -ForegroundColor DarkCyan
            return ($RecentBarcodes | Sort-Object -Property LastPlayedAgo | Select-Object -First $Limit)
        }
        $WiderBarcodes = @($OpponentTeams | Where-Object { $_.LastPlayedAgo -le $LastPlayedAgoMax })
        if ($WiderBarcodes.Count -gt 0) {
            return ($WiderBarcodes | Sort-Object -Property LastPlayedAgo | Select-Object -First $Limit)
        }
    }

    # Tight Pulse-anchored band first. If we have a player rating to anchor
    # against, prefer teams within +/- RATING_DELTA_CAP_MMR sorted by closest.
    # @(...) forces array context to defeat PowerShell's single-item unwrap.
    if ($PlayerRating -gt 0) {
        $ValidTeams = @($OpponentTeams | Where-Object { $_.RatingDelta -le $RATING_DELTA_CAP_MMR })
        if ($ValidTeams.Count -gt 0) {
            return ($ValidTeams | Sort-Object -Property RatingDelta | Select-Object -First $Limit)
        }
    }

    # Recency fallback: opponent is unranked, smurfing, or way off-rated.
    $ActiveOpponentTeams = @($OpponentTeams | Where-Object { $_.LastPlayedAgo -le $LastPlayedAgoMax })
    if ($ActiveOpponentTeams.Count -gt 0) {
        return ($ActiveOpponentTeams | Sort-Object -Property LastPlayedAgo | Select-Object -First $Limit)
    }

    return ($OpponentTeams | Sort-Object -Property LastPlayedAgo | Select-Object -First $Limit)
}

function Write-Toast {
    param([Object] $ToastNotifier, [string] $ToastText)
    $ToastXmlText = "<toast scenario='Urgent'><visual><binding template='ToastGeneric'><text>${ToastText}</text></binding></visual></toast>"
    $ToastXml = New-Object -TypeName Windows.Data.Xml.Dom.XmlDocument
    $ToastXml.LoadXml($ToastXmlText)
    $ToastNotifier.Show($ToastXml)
}

function Write-All {
    param([string] $Player, [string] $FilePath, [Object] $ToastNotifier)
    Write-Output -InputObject $Player
    if(-not [string]::IsNullOrEmpty($FilePath)) { $Player | Out-File -FilePath $FilePath -Encoding utf8 }
    if($ToastNotifier -ne $null) { Write-Toast -ToastNotifier $ToastNotifier -ToastText $Player }
}

function Get-PlayerTeams {
    param([int32[]]$Season, [string]$Queue, [string]$Race, [int64]$TeamId, [int64[]]$CharacterId)
    $PlayerTeams = @()
    foreach($CurSeasonId in $Season) {
        $PlayerTeams += (Get-Team -Season $CurSeasonId -Queue $Queue -Race $Race -TeamId $TeamId -CharacterId $CharacterId)
    }
    return $PlayerTeams
}

function Create-PlayerProfile {
    param([Object] $RecentTeam)
    if($RecentTeam -eq $null) { return $null }
    return [PSCustomObject]@{
        Team = $RecentTeam
        Character = $RecentTeam.Members[0].Character
        CharacterName = $RecentTeam.Members[0].Character.Name.Substring(0, $RecentTeam.Members[0].Character.Name.IndexOf("#"))
        Season = $RecentTeam.Season
        Region = $RecentTeam.Region
        Race = Get-TeamRace $RecentTeam
    }
}

function Find-PlayerProfile {
    # v0.9.1 -- pick the user's MAIN team (most games played this season)
    # rather than most-recently-played. Fixes the case where a smurf or
    # alt account has more recent activity than the main, which previously
    # caused the RatingDelta anchor to land on the alt's MMR.
    # Tiebreak by highest rating (the main is usually the highest-rated
    # of the user's accounts in a given season).
    param([Object[]] $PlayerTeam)
    if($PlayerTeam -eq $null -or $PlayerTeam.Length -eq 0) { return $null }
    $Now = [DateTimeOffset]::Now
    foreach($Team in $PlayerTeam) {
        $LastPlayedParsed = [DateTimeOffset]::Parse($Team.LastPlayed, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $LastPlayedAgo = $Now.Subtract($LastPlayedParsed).TotalSeconds
        $W = if ($null -ne $Team.Wins)   { [int32]$Team.Wins   } else { 0 }
        $L = if ($null -ne $Team.Losses) { [int32]$Team.Losses } else { 0 }
        $T = if ($null -ne $Team.Ties)   { [int32]$Team.Ties   } else { 0 }
        $GamesPlayed = $W + $L + $T
        Add-Member -InputObject $Team -Name LastPlayedAgo -Value $LastPlayedAgo -MemberType NoteProperty -Force
        Add-Member -InputObject $Team -Name GamesPlayed   -Value $GamesPlayed   -MemberType NoteProperty -Force
    }
    Write-Host " [Pulse] Candidate teams (race-filtered, all regions):" -ForegroundColor DarkCyan
    foreach($Team in $PlayerTeam) {
        $RegionLabel = if ($null -ne $Team.Region) { $Team.Region } else { "?" }
        $RaceLabel = Get-TeamRace $Team
        $NameLabel = if ($Team.Members -and $Team.Members[0].Character) { $Team.Members[0].Character.Name } else { "?" }
        Write-Host ("   - {0,-30} {1,-3} {2,-2} MMR={3,4} games={4,3} lastPlayed={5,4}s ago" -f `
            $NameLabel, $RegionLabel, $RaceLabel, $Team.Rating, $Team.GamesPlayed, [int32]$Team.LastPlayedAgo) -ForegroundColor DarkCyan
    }
    # Prefer the team that was played recently (within RECENT_ACTIVE_SECONDS).
    # Window is wide (24h) because Pulse's lastPlayed only updates AFTER a
    # match ends and ingests, and we want the anchor to follow you the
    # moment you switch regions, not 24 hours later. Falls back to
    # most-games when no team is in the recent window.
    $RECENT_ACTIVE_SECONDS = 86400
    # @(...) forces array context: when Where-Object returns ONE item,
    # PowerShell unwraps it to a single object whose .Length is $null,
    # which made the old `$Recent.Length -gt 0` check silently false.
    $Recent = @($PlayerTeam | Where-Object { $_.LastPlayedAgo -le $RECENT_ACTIVE_SECONDS })
    if ($Recent.Count -gt 0) {
        $Picked = $Recent | Sort-Object -Property @{Expression='LastPlayedAgo';Descending=$false}, @{Expression='Rating';Descending=$true} | Select-Object -First 1
        $Reason = "recently-active"
    } else {
        $Picked = $PlayerTeam | Sort-Object -Property @{Expression='GamesPlayed';Descending=$true}, @{Expression='Rating';Descending=$true} | Select-Object -First 1
        $Reason = "most-played"
    }
    Write-Host (" [Pulse] Anchor: {0} MMR={1} games={2} lastPlayed={3}s ago ({4})" -f `
        $Picked.Members[0].Character.Name, $Picked.Rating, $Picked.GamesPlayed, [int32]$Picked.LastPlayedAgo, $Reason) -ForegroundColor Green
    return Create-PlayerProfile -RecentTeam $Picked
}

$Seasons = (Invoke-EnhancedRestMethod -Uri "${Sc2PulseApiRoot}/season/list/all") | Group-Object -Property Region -AsHashTable
$SeasonIds = $Seasons.Values | ForEach-Object { $_ | Select-Object -First 1 } | Where-Object {$ActiveRegion -contains $_.Region} | Select-Object -ExpandProperty BattlenetId -Unique

Write-Host "Script loaded, waiting for games..." -ForegroundColor Cyan

# SC2 client API reachability tracking. Initialised to $false so the
# first successful poll prints a one-shot "reachable" message. The
# warn-throttle timestamp lets the main loop nudge the user every
# 30s while waiting, without flooding the console.
$Script:Sc2ClientReachable = $false
$Script:Sc2ClientLastWarn  = [DateTime]::MinValue

$InGame = $false
$CurrentOpponentId = $null
$CurrentOpponentName = $null
$CurrentMapName = $null
$LastKnownResult = $null
$CurrentMyRace = $null
$CurrentOpponentRace = $null

while($true) {
    $Game = Get-Game -CurrentGame $Script:CurrentGame -ValidPlayerCount $Script:ValidPlayerCount
    $Script:CurrentGame = $Game
    
    $HasValidGame = $Game -ne $null -and -not $Game.isReplay -and $Game.Players.Length -eq $Script:ValidPlayerCount
    $IsGameRunning = $HasValidGame -and -not $Game.Finished

    if ($IsGameRunning -and -not $InGame) {
        Write-Host "`n--- New game detected ---" -ForegroundColor White
        $InGame = $true
        
        $CurrentOpponentId = $null
        $CurrentOpponentName = $null
        $LastKnownResult = $null
        $CurrentMapName = if ($Game.PSObject.Properties.Name -contains 'map' -and -not [string]::IsNullOrEmpty($Game.map)) { $Game.map } else { "Unknown Map" }
        
        if(-not [string]::IsNullOrEmpty($FilePath) -and (Test-Path -Path $FilePath)) { Clear-Content -Path $FilePath }

        $Me = $Script:CurrentGame.Players | Where-Object { $_.Type -ne "computer" -and $_.Name -match $Script:MyNamePattern } | Select-Object -First 1
        $Opponent = $Script:CurrentGame.Players | Where-Object { $_.Type -ne "computer" -and $_.Name -notmatch $Script:MyNamePattern } | Select-Object -First 1

        if ($null -eq $Opponent -or $null -eq $Me) {
            Write-Host "Waiting for players to load fully..." -ForegroundColor Yellow
            continue
        }


        $CurrentMyRace = switch -Regex ($Me.Race) { "prot" {"PROTOSS"}; "terr" {"TERRAN"}; "zerg" {"ZERG"}; "rand" {"RANDOM"}; default {"UNKNOWN"} }
        $CurrentOpponentRace = switch -Regex ($Opponent.Race) { "prot" {"PROTOSS"}; "terr" {"TERRAN"}; "zerg" {"ZERG"}; "rand" {"RANDOM"}; default {"UNKNOWN"} }

        $PlayerTeams = Get-PlayerTeams -Season $Script:SeasonIds -Queue $Script:Queue1v1 -Race $CurrentMyRace -TeamId $Script:OverrideTeam -CharacterId $Script:CharacterId

        # v0.9.5 -- Auto-detect the active server BEFORE picking an anchor.
        # Matchmaking is single-region, so wherever Pulse finds the opponent's
        # name = the server we are on right now. This beats Pulse's ingestion
        # lag (lastPlayed for the user's team won't update until AFTER the
        # game ends), so it works the instant the user switches regions.
        # We probe each user-team region in order of most-recently-played
        # so the common case (user did NOT switch) hits on the first probe.
        $EncodedOppName = [uri]::EscapeDataString($Opponent.Name)
        $TeamsByRecency = $PlayerTeams | ForEach-Object {
            $Lp = [DateTimeOffset]::Parse($_.LastPlayed, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
            $LpAgo = [DateTimeOffset]::Now.Subtract($Lp).TotalSeconds
            Add-Member -InputObject $_ -Name LastPlayedAgo -Value $LpAgo -MemberType NoteProperty -Force
            $_
        } | Sort-Object -Property LastPlayedAgo

        $ActiveProfile = $null
        foreach ($UserTeam in $TeamsByRecency) {
            $ProbeRegion = $UserTeam.Region.ToUpper()
            $ProbeSeason = $UserTeam.Season
            $ProbeUri = "${Sc2PulseApiRoot}/character/search/advanced?season=${ProbeSeason}&region=${ProbeRegion}&queue=$($Script:Queue1v1)&name=${EncodedOppName}&caseSensitive=true"
            try {
                $Hits = @(Invoke-EnhancedRestMethod -Uri $ProbeUri)
                if ($Hits.Count -gt 0) {
                    $ActiveProfile = Create-PlayerProfile -RecentTeam $UserTeam
                    Write-Host (" [Pulse] Active region detected: {0} (opponent {1} found there, {2} candidate(s))" -f `
                        $ProbeRegion, $Opponent.Name, $Hits.Count) -ForegroundColor Green
                    break
                }
            } catch {
                # Per-region miss is normal; keep probing.
            }
        }

        if ($ActiveProfile) {
            $PlayerProfile = $ActiveProfile
        } else {
            Write-Host " [Pulse] Opponent name not found in any user region -- falling back to recently-active anchor" -ForegroundColor Yellow
            $PlayerProfile = Find-PlayerProfile -PlayerTeam $PlayerTeams
        }

        $SearchSeason = if ($PlayerProfile) { $PlayerProfile.Season } else { $Script:SeasonIds[0] }
        $SearchRegion = if ($PlayerProfile) { $PlayerProfile.Region.ToUpper() } else { $Script:ActiveRegion[0].ToUpper() }

        # Pass to the cleaned up Search Function
        $OpponentTeamObjects = Get-OpponentTeams -GameOpponent $Opponent -Season $SearchSeason -Race $CurrentOpponentRace -Queue $Script:Queue1v1 -LastPlayedAgoMax $Script:LastPlayedAgoMax -Limit $Script:Limit -Region $SearchRegion -PlayerRating ([int32]$PlayerProfile.Team.Rating)

        if ($OpponentTeamObjects) {
             $DisplayResults = @()
             foreach($TeamObj in $OpponentTeamObjects) {
                $BaseInfo = Unmask-Team -Team $TeamObj -RatingFormat $Script:RatingFormat -RaceFormat $Script:RaceFormat
                $TempId = $TeamObj.Members[0].Character.Id
                
                $HistoryRecord = Get-OpponentRecord -OpponentId $TempId -MyRace $CurrentMyRace -OpponentRace $CurrentOpponentRace
                
                if ($HistoryRecord) {
                    $BaseInfo += " ($($HistoryRecord.Wins)-$($HistoryRecord.Losses))"
                } else {
                    $BaseInfo += " (0-0)"
                }
                $DisplayResults += $BaseInfo
             }
             
             $UnmaskedString = $DisplayResults -join $Script:Separator
             $BestMatch = $OpponentTeamObjects | Select-Object -First 1
             $CurrentOpponentId = $BestMatch.Members[0].Character.Id
             $CurrentOpponentName = $BestMatch.Members[0].Character.Name

             Write-All -Player $UnmaskedString -FilePath $Script:FilePath -ToastNotifier $Script:ToastNotifier
        } else {
            $FallbackString = Unmask-GameOpponent -GameOpponent $Opponent -OpponentRace $CurrentOpponentRace -RaceFormat $Script:RaceFormat
            Write-All -Player $FallbackString -FilePath $Script:FilePath -ToastNotifier $Script:ToastNotifier
        }
    }

    if ($InGame -and $HasValidGame -and $null -eq $LastKnownResult) {
        $DetectedResult = Get-MyResult -Players $Game.Players
        if ($null -ne $DetectedResult) {
            $LastKnownResult = $DetectedResult
            Write-Host "Result captured via API: $LastKnownResult" -ForegroundColor Magenta
        }
    }

    if (-not $IsGameRunning -and $InGame) {
        Write-Host "--- Game finished ---" -ForegroundColor White
        
        if ([string]::IsNullOrEmpty($LastKnownResult)) {
            $LastKnownResult = "Defeat"
            Write-Host "Game ended without detected result (Early Leave). Defaulting to: Defeat" -ForegroundColor Yellow
        }

        if(-not [string]::IsNullOrEmpty($FilePath) -and (Test-Path -Path $FilePath)) { Clear-Content -Path $FilePath }
        
        if (-not [string]::IsNullOrEmpty($CurrentOpponentId) -and -not [string]::IsNullOrEmpty($LastKnownResult)) {
             Update-OpponentHistory -OpponentId $CurrentOpponentId -OpponentName $CurrentOpponentName -MyResult $LastKnownResult -MapName $CurrentMapName -MyRace $CurrentMyRace -OpponentRace $CurrentOpponentRace
        }

        $InGame = $false
    }

    $SleepSeconds = if ($InGame) {
        $InGamePollInterval
    } elseif (-not $Script:Sc2ClientReachable) {
        # SC2 not running -- relax the poll. 2s is a good balance:
        # fast enough that the user sees "reachable" within a
        # couple seconds of launching SC2, slow enough that we are
        # not pounding localhost or filling the console.
        $IdlePollIntervalNoSc2
    } else {
        $IdlePollInterval
    }
    Start-Sleep -Seconds $SleepSeconds
}
