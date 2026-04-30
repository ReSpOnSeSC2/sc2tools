; ============================================================================
; SC2 Tools -- Windows installer (NSIS Modern UI 2)
; ----------------------------------------------------------------------------
; This script is consumed by packaging/build-installer.ps1, which stages
; the source tree, downloads embeddable Python 3.12, pre-installs Python
; and Node.js dependencies under build\stage\, and finally invokes
; makensis.exe with /DVERSION=<git-tag> /DSTAGE_DIR=<path>.
;
; Design notes (see docs/adr/0001-installer-nsis-bundled-python.md):
;   * Per-user install (RequestExecutionLevel user). Default location is
;     %LOCALAPPDATA%\Programs\SC2Tools so the wizard, settings page, and
;     custom-builds cache can write to data\ without admin prompts. The
;     user can override the path on the Directory page (e.g. C:\SC2Tools).
;   * Uninstaller registered under HKCU, not HKLM.
;   * Bundled Python 3.12 ships at <INSTDIR>\python\. The launcher (Stage 3
;     SC2Replay-Analyzer\SC2ReplayAnalyzer.py) is invoked via pythonw.exe
;     with an absolute path, so no PATH or .py file association is needed.
;   * Node.js is detected on PATH but NOT bundled. If missing, we open
;     https://nodejs.org and abort. Bundling Node would double the
;     installer size and complicate Stage 7 community-builds sync; we
;     accept the small friction here for non-Stage-3 features.
;   * Uninstall walks the install tree explicitly rather than `RMDir /r
;     $INSTDIR` so a user who points at a populated directory does not
;     lose unrelated files.
; ============================================================================

Unicode True
SetCompressor /SOLID lzma

; ----- Build-time defines ---------------------------------------------------
!ifndef VERSION
  !define VERSION "0.0.0-dev"
!endif
!ifndef STAGE_DIR
  !define STAGE_DIR "..\build\stage"
!endif
!ifndef DIST_DIR
  !define DIST_DIR "..\dist"
!endif

!define APP_NAME       "SC2 Tools"
!define APP_PUBLISHER  "SC2 Tools"
!define APP_LAUNCHER   "SC2Replay-Analyzer\SC2ReplayAnalyzer.py"
!define UNINSTALL_KEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\SC2Tools"
!define APP_REG_ROOT   "Software\SC2Tools"
!define MIN_NODE_MAJOR "18"

Name        "${APP_NAME} ${VERSION}"
OutFile     "${DIST_DIR}\SC2Tools-Setup-${VERSION}.exe"
InstallDir  "$LOCALAPPDATA\Programs\SC2Tools"
InstallDirRegKey HKCU "${APP_REG_ROOT}" "InstallLocation"
RequestExecutionLevel user
ShowInstDetails   show
ShowUninstDetails show
BrandingText "SC2 Tools ${VERSION}"

; ----- Modern UI 2 ----------------------------------------------------------
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!define MUI_ICON               "installer-assets\icon.ico"
!define MUI_UNICON             "installer-assets\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT     "Launch SC2 Tools"
!define MUI_FINISHPAGE_RUN_FUNCTION "LaunchSC2Tools"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion               "0.0.0.0"
VIAddVersionKey "ProductName"      "${APP_NAME}"
VIAddVersionKey "ProductVersion"   "${VERSION}"
VIAddVersionKey "FileVersion"      "${VERSION}"
VIAddVersionKey "FileDescription"  "${APP_NAME} installer"
VIAddVersionKey "CompanyName"      "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright"   "(c) ${APP_PUBLISHER}"

; ----- Helper functions -----------------------------------------------------
; Detect Node.js >= MIN_NODE_MAJOR by parsing `node --version`.
; Sets $NodeMissing to "1" when not found or too old.
Var NodeMissing
Var NodeVerOut

Function DetectNode
  StrCpy $NodeMissing "0"
  nsExec::ExecToStack 'cmd.exe /c node --version'
  Pop $0
  Pop $NodeVerOut
  ${If} $0 != 0
    StrCpy $NodeMissing "1"
    Return
  ${EndIf}
  ; Output looks like "v18.20.4". Strip the leading "v" and trailing CRLF.
  StrCpy $1 $NodeVerOut 1
  ${If} $1 == "v"
    StrCpy $NodeVerOut $NodeVerOut "" 1
  ${EndIf}
  ; Take everything before the first "." -> major version.
  ${WordFind} $NodeVerOut "." "+1{" $2
  ${VersionCompare} $2 ${MIN_NODE_MAJOR} $3
  ; $3 == 2 means $2 < MIN_NODE_MAJOR
  ${If} $3 == 2
    StrCpy $NodeMissing "1"
  ${EndIf}
FunctionEnd

; Atomically (best-effort) write an empty config.json the wizard will fill in.
Function WriteEmptyConfig
  IfFileExists "$INSTDIR\data\config.json" done
    CreateDirectory "$INSTDIR\data"
    FileOpen   $0 "$INSTDIR\data\config.json" w
    FileWrite  $0 '{$\r$\n'
    FileWrite  $0 '  "schemaVersion": 1,$\r$\n'
    FileWrite  $0 '  "createdBy": "installer",$\r$\n'
    FileWrite  $0 '  "version": "${VERSION}"$\r$\n'
    FileWrite  $0 '}$\r$\n'
    FileClose  $0
  done:
FunctionEnd

; Custom Finish-page launch handler. Required because Exec (used inside
; MUI_FUNCTION_FINISHPAGE) takes one combined argument, but we need to
; invoke pythonw.exe with the launcher script path as a separate param.
Function LaunchSC2Tools
  ExecShell "" "$INSTDIR\python\pythonw.exe" '"$INSTDIR\${APP_LAUNCHER}"'
FunctionEnd

; ----- Init -----------------------------------------------------------------
Function .onInit
  ; Single-instance guard so two parallel installs don't race on $INSTDIR.
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "SC2ToolsInstaller") p .r1 ?e'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "The SC2 Tools installer is already running."
    Abort
  ${EndIf}
FunctionEnd

; ----- Install section ------------------------------------------------------
Section "SC2 Tools (required)" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"

  DetailPrint "Copying SC2 Tools files to $INSTDIR..."
  ; The staging directory holds the full deployable tree built by
  ; build-installer.ps1: bundled python\, pre-installed node_modules\,
  ; the source tree, and installer-assets\.
  File /r "${STAGE_DIR}\*.*"

  DetailPrint "Checking Node.js installation..."
  Call DetectNode
  ${If} $NodeMissing == "1"
    StrCpy $0 "Node.js ${MIN_NODE_MAJOR}+ is required for the overlay backend.$\r$\n"
    StrCpy $0 "$0Click Yes to open nodejs.org and continue.$\r$\n"
    StrCpy $0 "$0Click No to install Node.js later."
    MessageBox MB_YESNO|MB_ICONQUESTION $0 IDYES open IDNO continue
    open:
      ExecShell "open" "https://nodejs.org/en/download/"
    continue:
  ${EndIf}

  DetailPrint "Writing initial data\config.json..."
  Call WriteEmptyConfig

  DetailPrint "Creating shortcuts..."
  CreateDirectory "$SMPROGRAMS\SC2 Tools"
  CreateShortcut "$SMPROGRAMS\SC2 Tools\SC2 Tools.lnk" \
                 "$INSTDIR\python\pythonw.exe" \
                 '"$INSTDIR\${APP_LAUNCHER}"' \
                 "$INSTDIR\installer-assets\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\SC2 Tools\Uninstall SC2 Tools.lnk" \
                 "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\SC2 Tools.lnk" \
                 "$INSTDIR\python\pythonw.exe" \
                 '"$INSTDIR\${APP_LAUNCHER}"' \
                 "$INSTDIR\installer-assets\icon.ico" 0

  DetailPrint "Registering uninstaller..."
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKCU "${APP_REG_ROOT}"  "InstallLocation"  "$INSTDIR"
  WriteRegStr   HKCU "${APP_REG_ROOT}"  "Version"          "${VERSION}"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "DisplayName"      "${APP_NAME}"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "DisplayVersion"   "${VERSION}"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "Publisher"        "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "InstallLocation"  "$INSTDIR"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "DisplayIcon"      "$INSTDIR\installer-assets\icon.ico"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "UninstallString"  '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

; ----- Uninstall section ----------------------------------------------------
; We remove only the directories we created -- never `RMDir /r $INSTDIR`
; blindly. If the user chose an existing populated directory at install
; time, their other files survive.
Section "Uninstall"
  Delete "$DESKTOP\SC2 Tools.lnk"
  RMDir /r "$SMPROGRAMS\SC2 Tools"

  DetailPrint "Removing application files..."
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\SC2Replay-Analyzer"
  RMDir /r "$INSTDIR\reveal-sc2-opponent-main"
  RMDir /r "$INSTDIR\cloud"
  RMDir /r "$INSTDIR\docs"
  RMDir /r "$INSTDIR\packaging"
  RMDir /r "$INSTDIR\installer-assets"
  Delete   "$INSTDIR\Uninstall.exe"
  Delete   "$INSTDIR\README.md"
  Delete   "$INSTDIR\CHANGELOG.md"
  Delete   "$INSTDIR\MASTER_ROADMAP.md"

  ; data\ holds the user's profile, replay cache, and custom builds. In
  ; interactive mode we ASK before deleting (non-technical users often
  ; reinstall to fix a broken state and would lose history otherwise).
  ; In silent mode (/S, used by CI smoke tests and automation) we delete
  ; without prompting -- a silent uninstall must not hang on a dialog.
  IfFileExists "$INSTDIR\data\*.*" 0 skip_data
    IfSilent +3
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Delete saved profile, replays, and custom builds?$\r$\n$INSTDIR\data$\r$\n$\r$\nClick No to keep them." \
      IDNO skip_data
    RMDir /r "$INSTDIR\data"
  skip_data:

  ; Only remove the install dir itself if it ended up empty.
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${APP_REG_ROOT}"
SectionEnd
