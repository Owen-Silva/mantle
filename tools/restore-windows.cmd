@echo off
rem restore-windows.cmd - the Start menu's "Restore Windows taskbar" (installer/installer.nsh), and a
rem double-clickable way back in a clone. It runs restore-windows.ps1 beside it with -ExecutionPolicy Bypass,
rem so neither the execution policy nor a Mark-of-the-Web on the script can stop it, and needs no Mantle,
rem no Node and no Electron. Any arguments go to the script (e.g. -RestartExplorer).
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-windows.ps1" %*
set "MANTLE_RESTORE_CODE=%ERRORLEVEL%"
echo.
if "%MANTLE_RESTORE_CODE%"=="0" (
  echo Windows is back the way it was. You can close this window.
) else (
  echo The taskbar is not confirmed back yet. Run this again, or press Ctrl+Shift+Esc,
  echo select Windows Explorer, then Restart.
)
echo.
pause
exit /b %MANTLE_RESTORE_CODE%
