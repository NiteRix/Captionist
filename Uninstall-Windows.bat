@echo off
setlocal
title Captionist - Uninstall

set "DEST=%APPDATA%\Adobe\CEP\extensions\com.niterix.captionist"

echo.
echo  Removing Captionist from:
echo    %DEST%
echo.

if not exist "%DEST%" (
  echo  Nothing to remove - Captionist is not installed for this user.
) else (
  rd /s /q "%DEST%"
  if exist "%DEST%" (
    echo  [X] Could not remove it. Close Premiere Pro and try again.
  ) else (
    echo  [ok] Captionist removed.
  )
)

echo.
echo  The CEP "unsigned extensions" setting was left alone, because other
echo  extensions may rely on it. To clear it yourself:
echo    reg delete "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /f
echo.
pause
