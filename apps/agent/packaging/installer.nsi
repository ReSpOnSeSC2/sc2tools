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
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE}" /T'

    SetOutPath "$INSTDIR"
    File "..\dist\${APP_EXECUTABLE}"

    WriteRegStr HKCU "${APP_REG_KEY}" "InstallDir"     "$INSTDIR"
    WriteRegStr HKCU "${APP_REG_KEY}" "Version"         "${AGENT_VERSION}"

    WriteRegStr HKCU "${APP_UNINST_KEY}" "DisplayName"     "${APP_NAME}"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "DisplayVersion"  "${AGENT_VERSION}"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "Publisher"       "${APP_PUBLISHER}"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "DisplayIcon"     '"$INSTDIR\${APP_EXECUTABLE}"'
    WriteRegStr HKCU "${APP_UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "${APP_UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegStr HKCU "${APP_UNINST_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${APP_UNINST_KEY}" "URLInfoAbout"    "https://sc2tools.app"
    WriteRegDWORD HKCU "${APP_UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${APP_UNINST_KEY}" "NoRepair" 1

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKCU "${APP_UNINST_KEY}" "EstimatedSize" "$0"

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    CreateShortCut "${APP_STARTUP_LINK}"   "$INSTDIR\${APP_EXECUTABLE}" \
        "--start-minimized" "$INSTDIR\${APP_EXECUTABLE}" 0 SW_SHOWMINIMIZED
    CreateShortCut "${APP_STARTMENU_LINK}" "$INSTDIR\${APP_EXECUTABLE}" \
        "" "$INSTDIR\${APP_EXECUTABLE}"
    CreateShortCut "$DESKTOP\SC2 Tools Agent.lnk" \
        "$INSTDIR\${APP_EXECUTABLE}" "" "$INSTDIR\${APP_EXECUTABLE}"

    Exec '"$INSTDIR\${APP_EXECUTABLE}"'
SectionEnd

Section "Uninstall"
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE}" /T'

    Delete "${APP_STARTUP_LINK}"
    Delete "${APP_STARTMENU_LINK}"
    Delete "$DESKTOP\SC2 Tools Agent.lnk"

    Delete "$INSTDIR\${APP_EXECUTABLE}"
    Delete "$INSTDIR\Uninstall.exe"

    DeleteRegKey HKCU "${APP_UNINST_KEY}"
    DeleteRegKey HKCU "${APP_REG_KEY}"
SectionEnd
