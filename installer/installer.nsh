; installer/installer.nsh - Mantle's additions to electron-builder's one-click NSIS installer (lane inst-mantle,
; 2026-10-29). electron-builder includes this file by name from buildResources (installer/).
;
; THE RULE: Mantle changes the Windows shell (the taskbar's auto-hide flag, the cursor clip, notification
; banners, some Windows pieces it replaces). Its files are never replaced or removed while Windows is not back
; the way it was, and Mantle is never killed first. electron-builder's own "app is running" check would
; taskkill Mantle.exe /F, which is exactly the crash the restore script exists for, so it is replaced here
; (customCheckAppRunning) by put-windows-back.ps1: ask Mantle to quit (it puts Windows back itself), run
; tools\restore-windows.ps1 (stops what did not quit, puts Windows back, reads the taskbar back: "verified"),
; and check that nothing runs from the folder. If that cannot be confirmed, the installer or uninstaller says
; why and changes NOTHING; in a silent run it exits 3.
;
; Runs: the installer's install section (an update quits the old version this way), the uninstaller's
; un.onInit, and again in customUnInstall after the logon task is gone (a Mantle the task restarted in between
; is asked to quit too). Then, and only then, electron-builder removes the files.
;
; Also: the Start menu entry "Restore Windows taskbar" beside Mantle's, which runs the restore script through
; tools\restore-windows.cmd (PowerShell with -ExecutionPolicy Bypass, so neither the execution policy nor a
; Mark-of-the-Web on the file can stop it), and removal of the "Mantle" logon task on uninstall, only when it
; starts THIS copy's Mantle.exe.

!include LogicLib.nsh

!macro mantleBackFunction PREFIX
Function ${PREFIX}mantleBack
  ; in: the word for the log (install | uninstall) on the stack. Returns only when Windows is back.
  Exch $R7
  Push $R8
  Push $R9
  InitPluginsDir
  File "/oname=$PLUGINSDIR\put-windows-back.ps1" "${BUILD_RESOURCES_DIR}\put-windows-back.ps1"
  mantle_back_again:
    DetailPrint "Putting Windows back before Mantle's files are touched"
    nsExec::ExecToStack /TIMEOUT=240000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\put-windows-back.ps1" -InstallDir "$INSTDIR" -Why $R7'
    Pop $R8
    Pop $R9
    DetailPrint "$R9"
    StrCmp $R8 "0" mantle_back_done
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Mantle could not confirm that Windows is back the way it was, so nothing was changed.$\r$\n$\r$\n$R9$\r$\n$\r$\nRetry checks again. Cancel stops here and leaves Mantle installed (Start menu > Mantle > Restore Windows taskbar puts the taskbar back). If the taskbar is still missing: Ctrl+Shift+Esc, select Windows Explorer, then Restart." /SD IDCANCEL IDRETRY mantle_back_again
    SetErrorLevel 3
    Quit
  mantle_back_done:
  Pop $R9
  Pop $R8
  Pop $R7
FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro mantleBackFunction "un."
!else
  !insertmacro mantleBackFunction ""
!endif

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Push "uninstall"
    Call un.mantleBack
  !else
    Push "install"
    Call mantleBack
  !endif
!macroend

!macro customInstall
  ; The way back, next to the app's own shortcut ($SMPROGRAMS\Mantle\Mantle.lnk, menuCategory). It opens a
  ; .cmd (run by cmd.exe, so a policy that blocks .ps1 files cannot stop it), which runs the restore script with
  ; -ExecutionPolicy Bypass and waits for a key so its result can be read.
  CreateDirectory "$SMPROGRAMS\Mantle"
  CreateShortCut "$SMPROGRAMS\Mantle\Restore Windows taskbar.lnk" "$INSTDIR\resources\app\tools\restore-windows.cmd" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "Puts the Windows taskbar back the way it was before Mantle, with no Mantle running"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; 1. The "Mantle" logon task first, so nothing starts Mantle again while its files go (its restart-on-failure
    ;    would). Only when it starts THIS copy's Mantle.exe: a task that starts a clone is left alone.
    nsExec::ExecToStack /TIMEOUT=60000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\tools\install-autostart.ps1" -Uninstall -OnlyIfExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    Pop $R8
    Pop $R9
    DetailPrint "logon task: $R9"
    ${if} $R8 != "0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Mantle's start at sign-in could not be taken away ($R9). Mantle is still being removed: delete the task named Mantle in Task Scheduler." /SD IDOK
    ${endIf}
  ${endIf}
  ; 2. Windows back once more (a Mantle the task restarted in between is asked to quit too), then the files.
  Push "uninstall"
  Call un.mantleBack
  ${ifNot} ${isUpdated}
    Delete "$SMPROGRAMS\Mantle\Restore Windows taskbar.lnk"
  ${endIf}
!macroend
