; NSIS installer for the SC2 Tools Agent.
;
; Build with:
;   makensis -DAGENT_VERSION=0.3.0 packaging/installer.nsi
;
; The installer:
;   * places sc2tools-agent.exe under %LOCALAPPDATA%\sc2tools (per-user;
;     no admin elevation required so SmartScreen behaves);
;   * registers a Startup-folder shortcut so the agent runs on every
;     login (with --start-minimized so it never pops a window at logon);
;   * adds an "SC2 Tools Agent" Start menu entry (launches the GUI);
;   * adds an optional desktop shortcut;
;   * registers the uninstaller in Add/Remove Programs.
;
; If you want the auto-updater to ship signed binaries, sign the
; output .exe with signtool AFTER NSIS finishes:
;   signtool sign /fd SHA256 /tr http://timestamp.sectigo.com /td SHA256 \
;     /a SC2ToolsAgent-Setup-${AGENT_VERSION}.exe

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
!define MUI_ICON   "icon.ico"
!define MUI_UNICON "icon.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
    ; Stop any running agent so we can replace the .exe in place.
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE}" /T'

    SetOutPath "$INSTDIR"

    ; The PyInstaller one-file build emits a single .exe to dist/.
    File "..\dist\${APP_EXECUTABLE}"

    ; Persist the install dir so the uninstaller can find us.
    WriteRegStr HKCU "${APP_REG_KEY}" "InstallDir"     "$INSTDIR"
    WriteRegStr HKCU "${APP_REG_KEY}" "Version"         "${AGENT_VERSION}"

    ; Add/Remove Programs entry.
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

    ; Auto-start at logon. Per-user Startup folder, no admin needed.
    ;   * Startup-folder shortcut passes --start-minimized so the agent
    ;     comes up to the system tray on every boot.
    ;   * Start Menu shortcut launches the GUI window directly so a user
    ;     who clicked it actually sees the dashboard.
    CreateShortCut "${APP_STARTUP_LINK}"   "$INSTDIR\${APP_EXECUTABLE}" \
        "--start-minimized" "$INSTDIR\${APP_EXECUTABLE}" 0 SW_SHOWMINIMIZED
    CreateShortCut "${APP_STARTMENU_LINK}" "$INSTDIR\${APP_EXECUTABLE}" \
        "" "$INSTDIR\${APP_EXECUTABLE}"

    ; Optional desktop shortcut for non-technical users.
    CreateShortCut "$DESKTOP\SC2 Tools Agent.lnk" \
        "$INSTDIR\${APP_EXECUTABLE}" "" "$INSTDIR\${APP_EXECUTABLE}"

    ; Launch the freshly-installed agent so the user does not have to
    ; reboot or hunt for the icon.
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

    ; State (pairing token, log files) lives at the same %LOCALAPPDATA%
    ; root but in a sibling subfolder. Leave it intact on uninstall -
    ; users running a re-install or moving to a beta channel expect to
    ; keep their pairing.
SectionEnd
