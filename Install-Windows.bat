@echo off
setlocal enabledelayedexpansion
title Captionist - Install

rem ---------------------------------------------------------------------------
rem  Captionist installer for Windows.
rem  Copies the panel into Premiere's user extension folder and tells CEP that
rem  unsigned extensions are allowed to load. Nothing needs admin rights,
rem  because everything lives under the current user's AppData.
rem
rem  Switches:  /silent    no prompts, no pause at the end
rem ---------------------------------------------------------------------------

set "EXT_ID=com.niterix.captionist"
set "DEST=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"
set "SILENT=0"

for %%A in (%*) do (
  if /i "%%~A"=="/silent" set "SILENT=1"
)

echo.
echo  ===========================================
echo    Captionist for Premiere Pro
echo  ===========================================
echo.

rem --- locate the payload ----------------------------------------------------
set "SRC="
if exist "%~dp0extension\CSXS\manifest.xml" set "SRC=%~dp0extension"
if not defined SRC if exist "%~dp0..\..\extension\CSXS\manifest.xml" set "SRC=%~dp0..\..\extension"
if not defined SRC if exist "%~dp0..\extension\CSXS\manifest.xml" set "SRC=%~dp0..\extension"

if not defined SRC (
  echo  [X] Could not find the "extension" folder next to this installer.
  echo      Keep Install-Windows.bat in the same folder as "extension".
  goto :fail
)

rem --- is Premiere running? --------------------------------------------------
tasklist /fi "imagename eq Adobe Premiere Pro.exe" 2>nul | find /i "Adobe Premiere Pro.exe" >nul
if not errorlevel 1 (
  echo  [!] Premiere Pro is open. The panel will only appear after you restart it.
  echo.
)

rem --- copy ------------------------------------------------------------------
echo  Installing to:
echo    %DEST%
echo.

if exist "%DEST%" (
  rd /s /q "%DEST%" 2>nul
)
mkdir "%DEST%" 2>nul
xcopy "%SRC%\*" "%DEST%\" /e /i /q /y >nul
if errorlevel 1 (
  echo  [X] Copy failed. Close Premiere Pro and run this again.
  goto :fail
)
echo  [ok] Panel files copied.

rem --- allow unsigned extensions --------------------------------------------
for %%V in (6 7 8 9 10 11 12) do (
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo  [ok] Unsigned extensions enabled for CEP 6-12.

rem --- bundled tools ----------------------------------------------------------
rem Both tools ship inside the extension. Nothing is downloaded at install time:
rem an installer that fetched an archive and dropped an executable into an app
rem folder looks exactly like a dropper to heuristic antivirus.
set "MISSING="
if not exist "%DEST%\bin\ffmpeg.exe"      set "MISSING=!MISSING! ffmpeg"
if not exist "%DEST%\bin\whisper-cli.exe" set "MISSING=!MISSING! whisper-cli"

if defined MISSING (
  echo  [!] These bundled tools are missing:!MISSING!
  echo      Captionist will not be able to transcribe. Re-download the release
  echo      from https://github.com/NiteRix/Captionist/releases
) else (
  echo  [ok] ffmpeg and whisper-cli are bundled - nothing to download.
)

echo.
echo  Speech models are NOT bundled - they are hundreds of megabytes and which
echo  one you want is your call. Pick one in the panel^'s Models tab; they are
echo  stored in %%APPDATA%%\Captionist\models and survive updates.

rem ---------------------------------------------------------------------------
:done
echo.
echo  ===========================================
echo    Done.
echo.
echo    Restart Premiere Pro, then open:
echo      Window  ^>  Extensions  ^>  Captionist
echo  ===========================================
echo.
if "%SILENT%"=="0" pause
exit /b 0

:fail
echo.
if "%SILENT%"=="0" pause
exit /b 1
