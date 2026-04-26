<#PSScriptInfo
.VERSION 0.8.5
.GUID db8ffc68-4388-4119-b437-1f56c999611e
.AUTHOR nephestdev@gmail.com (Modified by Gemini)
.DESCRIPTION 
 Reveals ranked 1v1 opponent names for StarCraft2 and tracks Head-to-Head history.
 v0.8.5 - Removed RatingDeltaMax entirely. Relies solely on OCR strict match or Recency fallback.
#> 
param(
    [int64[]]$CharacterId,
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
$HistoryFilePath = Join-Path $PSScriptRoot "MyOpponentHistory.json"
$IdlePollInterval    = 0.5   
$InGamePollInterval  = 0.5   
# ---------------------------------

if ($null -eq $CharacterId -or $CharacterId.Length -eq 0) {
    Write-Host "No CharacterId provided. Scanning local SC2 Documents folder to auto-detect..." -ForegroundColor Cyan
    $DocumentsPath = [Environment]::GetFolderPath("MyDocuments")
    $Sc2Path = Join-Path $DocumentsPath "StarCraft II\Accounts"
    
    $DetectedIds = @()
    if (Test-Path $Sc2Path) {
        $Profiles = Get-ChildItem -Path $Sc2Path -Depth 2 | Where-Object { $_.PSIsContainer -and $_.Name -match '^\d+-S2-\d+-\d+$' }
        foreach ($Profile in $Profiles) {
            $Id = $Profile.Name.Split('-')[-1]
            if ($Id -as [int64]) { $DetectedIds += [int64]$Id }
        }
    }
    
    if ($DetectedIds.Length -gt 0) {
        $CharacterId = @($DetectedIds | Select-Object -Unique)
        Write-Host "Auto-detected $($CharacterId.Length) profile IDs from local files." -ForegroundColor Green
    } else {
        Write-Host "Could not auto-detect Character IDs. Please provide -CharacterId." -ForegroundColor Red
        exit
    }
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

function Save-History {
    param($HistoryData)
    $Json = $HistoryData | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($HistoryFilePath, $Json, [System.Text.Encoding]::UTF8)
}

function Update-OpponentHistory {
    param([string]$OpponentId, [string]$OpponentName, [string]$MyResult, [string]$MapName, [string]$MyRace, [string]$OpponentRace)
    if ([string]::IsNullOrEmpty($OpponentId)) { return }

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
    $Me = $Players | Where-Object { $_.Type -ne "computer" -and $_.Name -match "(?i)ReSpOnSe" } | Select-Object -First 1
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
        [System.Net.HttpStatusCode[]]$ValidResponseCodes = @([System.Net.HttpStatusCode]::OK, [System.Net.HttpStatusCode]::NotFound)
    )
    $ProgressPreference = 'SilentlyContinue';
    $Response = try { (Invoke-WebRequest -UseBasicParsing -Method $Method -Uri $Uri -Body $Body) }  catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            try {
                $Stream = $_.Exception.Response.GetResponseStream()
                $Reader = New-Object System.IO.StreamReader($Stream)
                $ErrBody = $Reader.ReadToEnd()
                if (-not [string]::IsNullOrWhiteSpace($ErrBody)) {
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
    try { $Game = Invoke-EnhancedRestMethod -Uri "${Sc2ClientApiRoot}/game" } catch [System.Net.WebException] { return }
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
    param(
        [Object] $GameOpponent,
        [int32] $Season,
        [string] $Race,
        [string] $Queue,
        [int32] $LastPlayedAgoMax,
        [int32] $Limit,
        [string] $Region,
        [int32] $ScannedMMR = 0
    )
    
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

        # Only check RatingDelta if the OCR successfully gave us a target MMR
        if ($ScannedMMR -gt 0) {
            $RatingDelta = [Math]::Abs($Team.Rating - $ScannedMMR)
            Add-Member -InputObject $Team -Name RatingDelta -Value $RatingDelta -MemberType NoteProperty -Force
        }
    }

    # If OCR succeeded, enforce a tight MMR match (150 Delta) and sort by closest match
    if ($ScannedMMR -gt 0) {
        $ValidTeams = $OpponentTeams | Where-Object { $_.RatingDelta -le 150 }
        if ($ValidTeams.Length -gt 0) {
            return ($ValidTeams | Sort-Object -Property RatingDelta | Select-Object -First $Limit)
        }
    }

    # Pure Recency fallback if OCR failed or opponent is unranked (ignores MMR entirely)
    $ActiveOpponentTeams = $OpponentTeams | Where-Object { $_.LastPlayedAgo -le $LastPlayedAgoMax }
    if ($ActiveOpponentTeams.Length -gt 0) {
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
    param([Object[]] $PlayerTeam)
    if($PlayerTeam -eq $null -or $PlayerTeam.Length -eq 0) { return $null }
    $Now = [DateTimeOffset]::Now
    foreach($Team in $PlayerTeam) {
        $LastPlayedParsed = [DateTimeOffset]::Parse($Team.LastPlayed, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $LastPlayedAgo = $Now.Subtract($LastPlayedParsed).TotalSeconds
        Add-Member -InputObject $Team -Name LastPlayedAgo -Value $LastPlayedAgo -MemberType NoteProperty -Force
    }
    return Create-PlayerProfile -RecentTeam ($PlayerTeam | Sort-Object -Property LastPlayedAgo | Select-Object -First 1)
}

$Seasons = (Invoke-EnhancedRestMethod -Uri "${Sc2PulseApiRoot}/season/list/all") | Group-Object -Property Region -AsHashTable
$SeasonIds = $Seasons.Values | ForEach-Object { $_ | Select-Object -First 1 } | Where-Object {$ActiveRegion -contains $_.Region} | Select-Object -ExpandProperty BattlenetId -Unique

Write-Host "Script loaded, waiting for games..." -ForegroundColor Cyan

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

        $Me = $Script:CurrentGame.Players | Where-Object { $_.Type -ne "computer" -and $_.Name -match "(?i)ReSpOnSe" } | Select-Object -First 1
        $Opponent = $Script:CurrentGame.Players | Where-Object { $_.Type -ne "computer" -and $_.Name -notmatch "(?i)ReSpOnSe" } | Select-Object -First 1

        if ($null -eq $Opponent -or $null -eq $Me) {
            Write-Host "Waiting for players to load fully..." -ForegroundColor Yellow
            continue
        }

        # --- READ OCR SCANNER DATA ---
        $ScannedMMR = 0
        if (Test-Path "scanned_mmr.txt") {
            $ScannedText = Get-Content "scanned_mmr.txt" -Raw
            if ([int32]::TryParse($ScannedText.Trim(), [ref]$ScannedMMR)) {
                Write-Host " [OCR] Successfully loaded scanned MMR: $ScannedMMR" -ForegroundColor Green
            }
            Remove-Item "scanned_mmr.txt" -ErrorAction SilentlyContinue
        }

        $CurrentMyRace = switch -Regex ($Me.Race) { "prot" {"PROTOSS"}; "terr" {"TERRAN"}; "zerg" {"ZERG"}; "rand" {"RANDOM"}; default {"UNKNOWN"} }
        $CurrentOpponentRace = switch -Regex ($Opponent.Race) { "prot" {"PROTOSS"}; "terr" {"TERRAN"}; "zerg" {"ZERG"}; "rand" {"RANDOM"}; default {"UNKNOWN"} }

        $PlayerTeams = Get-PlayerTeams -Season $Script:SeasonIds -Queue $Script:Queue1v1 -Race $CurrentMyRace -TeamId $Script:OverrideTeam -CharacterId $Script:CharacterId
        $PlayerProfile = Find-PlayerProfile -PlayerTeam $PlayerTeams

        $SearchSeason = if ($PlayerProfile) { $PlayerProfile.Season } else { $Script:SeasonIds[0] }
        $SearchRegion = if ($PlayerProfile) { $PlayerProfile.Region.ToUpper() } else { $Script:ActiveRegion[0].ToUpper() }

        # Pass to the cleaned up Search Function
        $OpponentTeamObjects = Get-OpponentTeams -GameOpponent $Opponent -Season $SearchSeason -Race $CurrentOpponentRace -Queue $Script:Queue1v1 -LastPlayedAgoMax $Script:LastPlayedAgoMax -Limit $Script:Limit -Region $SearchRegion -ScannedMMR $ScannedMMR

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

    $SleepSeconds = if ($InGame) { $InGamePollInterval } else { $IdlePollInterval }
    Start-Sleep -Seconds $SleepSeconds
}