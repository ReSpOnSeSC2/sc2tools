; NSIS installer for the SC2 Tools Agent.
;
; Build with:
;   makensis -DAGENT_VERSION=0.3.0 packaging/installer.nsi

Unicode True
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef AGENT_VERSION
  !define AGENT_VERSION "0.0.0-dev"
!endif

!define APP_NAME           "SC2 Tools Agent"
!define APP_PUBLISHER      "SC2 Tools"
!define APP_EXECUTABLE     "sc2tools-agent.exe"
!define APP_REG_KEY        "Software\SC2Tools\Agent"
!define APP_UNINST_KEY     "Software\Microsoft\Windows\CurrentVersion\Uninstall\SC2ToolsAgent"
!define APP_INSTALL_DIR    "$LOCALAPPDATA\sc2tools"
!define APP_STARTUP_LINK   "$SMSTARTUP\SC2 Tools Agent.lnk"
!define APP_STARTMENU_LINK "$SMPROGRAMS\SC2 Tools Agent.lnk"
!define APP_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define APP_RUN_VALUE "SC2ToolsAgent"

Var StartOnLogin
Var DesktopShortcut
Var StartCheckbox
Var DesktopCheckbox
Var OptionsDialog
Var DeleteUserData
Var DeleteDataCheckbox

Name "${APP_NAME}"
OutFile "..\dist\SC2ToolsAgent-Setup-${AGENT_VERSION}.exe"
InstallDir "${APP_INSTALL_DIR}"
InstallDirRegKey HKCU "${APP_REG_KEY}" "InstallDir"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${AGENT_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileVersion" "${AGENT_VERSION}"
VIAddVersionKey "ProductVersion" "${AGENT_VERSION}"
VIAddVersionKey "FileDescription" "Background uploader for the SC2 Tools cloud."
VIAddVersionKey "LegalCopyright" "(c) SC2 Tools contributors"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define MUI_ABORTWARNING
; Custom installer/uninstaller icons are optional. We only define
; MUI_ICON / MUI_UNICON when the file is present so NSIS falls back
; to its default icon instead of aborting with "can't open file".
!if /FileExists "${__FILEDIR__}\icon.ico"
  !define MUI_ICON   "icon.ico"
  !define MUI_UNICON "icon.ico"
!endif

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom OptionsCreate OptionsLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch SC2 Tools now"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataOptionsCreate un.DataOptionsLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
    SetShellVarContext current
    StrCpy $StartOnLogin ${BST_CHECKED}
    StrCpy $DesktopShortcut ${BST_CHECKED}
    ; An upgrade, including silent /S, preserves an explicit startup opt-out.
    ReadRegStr $0 HKCU "${APP_REG_KEY}" "InstallDir"
    ${If} $0 != ""
        StrCpy $StartOnLogin ${BST_UNCHECKED}
        ReadRegStr $1 HKCU "${APP_RUN_KEY}" "${APP_RUN_VALUE}"
        ${If} $1 != ""
            StrCpy $StartOnLogin ${BST_CHECKED}
        ${EndIf}
        IfFileExists "${APP_STARTUP_LINK}" 0 +2
            StrCpy $StartOnLogin ${BST_CHECKED}
        StrCpy $DesktopShortcut ${BST_UNCHECKED}
        IfFileExists "$DESKTOP\SC2 Tools Agent.lnk" 0 +2
            StrCpy $DesktopShortcut ${BST_CHECKED}
    ${EndIf}
FunctionEnd

Function OptionsCreate
    !insertmacro MUI_HEADER_TEXT "Installation options" "Choose how SC2 Tools starts and where its shortcut appears."
    nsDialogs::Create 1018
    Pop $OptionsDialog
    ${If} $OptionsDialog == error
        Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0 0 100% 20u "Start SC2 Tools when Windows starts"
    Pop $StartCheckbox
    ${NSD_SetState} $StartCheckbox $StartOnLogin
    ${NSD_CreateCheckbox} 0 30u 100% 20u "Create desktop shortcut"
    Pop $DesktopCheckbox
    ${NSD_SetState} $DesktopCheckbox $DesktopShortcut
    nsDialogs::Show
FunctionEnd

Function OptionsLeave
    ${NSD_GetState} $StartCheckbox $StartOnLogin
    ${NSD_GetState} $DesktopCheckbox $DesktopShortcut
FunctionEnd

Function un.onInit
    SetShellVarContext current
    StrCpy $DeleteUserData ${BST_UNCHECKED}
FunctionEnd

Function un.DataOptionsCreate
    !insertmacro MUI_HEADER_TEXT "Keep your settings?" "Your replay folders are never deleted."
    nsDialogs::Create 1018
    Pop $OptionsDialog
    ${If} $OptionsDialog == error
        Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 40u "By default, pairing, settings and logs stay on this PC for reinstalling. Check below only if you want to erase SC2 Tools local data. Synced cloud games are unchanged."
    Pop $0
    ${NSD_CreateCheckbox} 0 50u 100% 30u "Delete local settings, pairing, logs and cached SC2 Tools data"
    Pop $DeleteDataCheckbox
    ${NSD_SetState} $DeleteDataCheckbox $DeleteUserData
    nsDialogs::Show
FunctionEnd

Function un.DataOptionsLeave
    ${NSD_GetState} $DeleteDataCheckbox $DeleteUserData
FunctionEnd

Section "Install"
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE}" /T'

    SetOutPath "$INSTDIR"
    ; v0.5.8: switched the PyInstaller spec to one-folder mode so
    ; multiprocessing children don't re-extract a 319 MB onefile bundle
    ; per spawn (which was causing every parse worker to die with
    ; BrokenProcessPool when parse_concurrency was high). The build now
    ; emits dist\sc2tools-agent\<everything>; we copy the folder
    ; contents recursively into $INSTDIR. The /r flag walks
    ; subdirectories (including _internal\ which holds the bundled
    ; Python runtime, Qt plugins, sc2reader data, analyzer source, etc.)
    File /r "..\dist\sc2tools-agent\*.*"

    WriteRegStr HKCU "${APP_REG_KEY}" "InstallDir"     "$INSTDIR"
    WriteRegStr HKCU "${APP_REG_KEY}" "Version"         "${AGENT_VERSION}"

    WriteRegStr HKCU "${APP_UNINST_KEY}" "DisplayName"     "${APP_NAME}"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "DisplayVersion"  "${AGENT_VERSION}"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "Publisher"       "${APP_PUBLISHER}"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "DisplayIcon"     '"$INSTDIR\${APP_EXECUTABLE}"'
    WriteRegStr HKCU "${APP_UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "${APP_UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegStr HKCU "${APP_UNINST_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "URLInfoAbout"    "https://sc2tools.com"
    WriteRegDWORD HKCU "${APP_UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${APP_UNINST_KEY}" "NoRepair" 1

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKCU "${APP_UNINST_KEY}" "EstimatedSize" "$0"

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ; Migrate the owned legacy shortcut only after the Run command is written.
    IfFileExists "${APP_STARTUP_LINK}" 0 legacy_migration_done
        WriteRegStr HKCU "${APP_RUN_KEY}" "${APP_RUN_VALUE}" '"$INSTDIR\${APP_EXECUTABLE}" --start-minimized'
    legacy_migration_done:
    Delete "${APP_STARTUP_LINK}"
    ${If} $StartOnLogin == ${BST_CHECKED}
        WriteRegStr HKCU "${APP_RUN_KEY}" "${APP_RUN_VALUE}" '"$INSTDIR\${APP_EXECUTABLE}" --start-minimized'
    ${Else}
        DeleteRegValue HKCU "${APP_RUN_KEY}" "${APP_RUN_VALUE}"
    ${EndIf}
    CreateShortCut "${APP_STARTMENU_LINK}" "$INSTDIR\${APP_EXECUTABLE}" \
        "" "$INSTDIR\${APP_EXECUTABLE}"
    ${If} $DesktopShortcut == ${BST_CHECKED}
        CreateShortCut "$DESKTOP\SC2 Tools Agent.lnk" \
            "$INSTDIR\${APP_EXECUTABLE}" "" "$INSTDIR\${APP_EXECUTABLE}"
    ${Else}
        Delete "$DESKTOP\SC2 Tools Agent.lnk"
    ${EndIf}

    ; Silent updater installs relaunch hidden; the interactive Finish page owns Launch now.
    IfSilent 0 silent_relaunch_done
        Exec '"$INSTDIR\${APP_EXECUTABLE}" --start-minimized'
    silent_relaunch_done:
SectionEnd

Section "Uninstall"
    DeleteRegValue HKCU "${APP_RUN_KEY}" "${APP_RUN_VALUE}"
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE}" /T'

    Delete "${APP_STARTUP_LINK}"
    Delete "${APP_STARTMENU_LINK}"
    Delete "$DESKTOP\SC2 Tools Agent.lnk"

    Delete "$INSTDIR\${APP_EXECUTABLE}"
    Delete "$INSTDIR\Uninstall.exe"
    ; v0.5.8: one-folder PyInstaller layout writes its bundled deps
    ; under $INSTDIR\_internal\ (Python runtime, Qt plugins, sc2reader
    ; data, analyzer source). Remove that subtree on uninstall.
    ; CRITICAL: do NOT use ``RMDir /r "$INSTDIR"`` here — the user's
    ; agent state lives next to the binary (data\, logs\, agent.json,
    ; player_handle.json) and a wholesale removal would erase pairing
    ; tokens and the dedupe cursor. Restrict deletion to the install-
    ; managed _internal\ subtree only.
    RMDir /r "$INSTDIR\_internal"

    ; Only explicit opt-in removes these app-owned paths. Never use replay
    ; folder overrides or a recursive removal of the install/data root.
    ${If} $DeleteUserData == ${BST_CHECKED}
        Delete "$LOCALAPPDATA\sc2tools\agent.json"
        Delete "$LOCALAPPDATA\sc2tools\player_handle.json"
        RMDir /r "$LOCALAPPDATA\sc2tools\logs"
        RMDir /r "$LOCALAPPDATA\sc2tools\data"
        RMDir /r "$LOCALAPPDATA\sc2tools\streaming"
        RMDir /r "$LOCALAPPDATA\sc2tools\replay-observations"
    ${EndIf}

    DeleteRegKey HKCU "${APP_UNINST_KEY}"
    DeleteRegKey HKCU "${APP_REG_KEY}"
SectionEnd
