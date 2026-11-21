@echo off
rem 3D Surface Tracker - Windows installer. Right-click > "Run as administrator".
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click install-windows.bat and choose "Run as administrator".
  pause
  exit /b 1
)

set "PLUGINS=%CommonProgramFiles%\Adobe\Common\Plug-ins\7.0\MediaCore\3D Surface Tracker"
set "EXT=%APPDATA%\Adobe\CEP\extensions\com.surftrack.panel"

echo 3D Surface Tracker - installation
echo.
echo 1/3  Effect and bridge plug-ins -^> %PLUGINS%
if not exist "%PLUGINS%" mkdir "%PLUGINS%"
copy /Y "plugins\STEffect.aex" "%PLUGINS%\" >nul || goto :fail
copy /Y "plugins\STBridge.aex" "%PLUGINS%\" >nul || goto :fail

echo 2/3  Tracker panel -^> %EXT%
if exist "%EXT%" rmdir /S /Q "%EXT%"
xcopy /E /I /Q /Y "extension" "%EXT%" >nul || goto :fail

echo 3/3  Allowing the (unsigned) panel to load in After Effects
for %%v in (9 10 11 12 13 14) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

echo.
echo Done. Restart After Effects, then:
echo  - Edit ^> Preferences ^> Scripting ^& Expressions: tick "Allow Scripts to Write Files and Access Network"
echo  - Effect ^> TeeVy ^> 3D Surface Tracker, then click "Open tracker"
echo.
pause
exit /b 0

:fail
echo.
echo Installation failed (see the message above).
pause
exit /b 1
