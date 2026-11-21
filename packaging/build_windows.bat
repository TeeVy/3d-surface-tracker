@echo off
rem ============================================================================
rem  3D Surface Tracker - Windows build (plug-ins + engine + release package)
rem
rem  Not tested yet: written on macOS, to be run on Windows 10/11 x64 with
rem   - Visual Studio 2022 (or Build Tools) with "Desktop development with C++",
rem     run from an "x64 Native Tools Command Prompt for VS 2022"
rem   - the After Effects SDK for Windows unzipped in AfterEffectsSDK\ (or set AE_SDK
rem     to its Examples folder)
rem   - Python 3.10+ x64 from python.org (the "py" launcher)
rem
rem  Output: out\release\3D-Surface-Tracker-<version>-win.zip
rem ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."
set "ROOT=%CD%"
if "%AE_SDK%"=="" set "AE_SDK=%ROOT%\AfterEffectsSDK\Examples"
if not exist "%AE_SDK%\Headers" ( echo After Effects SDK not found: %AE_SDK% & exit /b 1 )
where cl >nul 2>&1 || ( echo Run this from an "x64 Native Tools Command Prompt for VS 2022". & exit /b 1 )

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "([xml](Get-Content panel\CSXS\manifest.xml)).ExtensionManifest.ExtensionBundleVersion"`) do set "VERSION=%%v"
set "OUT=%ROOT%\out\win"
if not exist "%OUT%" mkdir "%OUT%"
set INC=/I "%AE_SDK%\Headers" /I "%AE_SDK%\Headers\SP" /I "%AE_SDK%\Headers\adobesdk" /I "%AE_SDK%\Headers\adobesdk\config" /I "%AE_SDK%\Headers\adobesdk\drawbot" /I "%AE_SDK%\Util"

rem ---------------------------------------------------------------- plug-ins (.aex)
for %%p in (STBridge STEffect) do (
  echo Building %%p.aex
  rem PiPL resource, as in the SDK samples: preprocess, PiPLTool, preprocess again, rc
  cl /nologo /I "%AE_SDK%\Headers" /EP "native\%%p\%%p_PiPL.r" > "%OUT%\%%p.rr" || exit /b 1
  "%AE_SDK%\Resources\PiPLTool.exe" "%OUT%\%%p.rr" "%OUT%\%%p.rrc" || exit /b 1
  cl /nologo /D "MSWindows" /EP "%OUT%\%%p.rrc" > "%OUT%\%%p.rc" || exit /b 1
  rc /nologo /fo "%OUT%\%%p.res" "%OUT%\%%p.rc" || exit /b 1
  cl /nologo /LD /O2 /EHsc /std:c++17 /utf-8 /DMSWindows /DWIN32 /D_WINDOWS /DNDEBUG %INC% ^
     "native\%%p\%%p.cpp" "%AE_SDK%\Util\AEGP_SuiteHandler.cpp" "%AE_SDK%\Util\MissingSuiteError.cpp" ^
     "%OUT%\%%p.res" /Fo"%OUT%\\" /Fe"%OUT%\%%p.aex" /link ws2_32.lib user32.lib || exit /b 1
)

rem ---------------------------------------------------------------- engine (PyInstaller)
set "VENV=%ROOT%\out\build-venv-win"
if not exist "%VENV%\Scripts\python.exe" (
  py -3 -m venv "%VENV%" || exit /b 1
  "%VENV%\Scripts\python.exe" -m pip install -q --upgrade pip
  "%VENV%\Scripts\python.exe" -m pip install -q "opencv-python-headless>=4.10" "numpy>=1.24" pyinstaller || exit /b 1
)
if exist "%ROOT%\out\engine\win-x64" rmdir /S /Q "%ROOT%\out\engine\win-x64"
"%VENV%\Scripts\pyinstaller.exe" --noconfirm --clean --log-level WARN --name st-engine --onedir --console ^
  --distpath "%ROOT%\out\engine\win-x64" --workpath "%ROOT%\out\engine-work-win" --specpath "%ROOT%\out\engine-work-win" ^
  --exclude-module tkinter "%ROOT%\engine.py" || exit /b 1

rem ---------------------------------------------------------------- package
set "NAME=3D-Surface-Tracker-%VERSION%-win"
set "DIR=%ROOT%\out\release\%NAME%"
if exist "%DIR%" rmdir /S /Q "%DIR%"
mkdir "%DIR%\plugins" "%DIR%\extension\engine\win-x64"
copy /Y "%OUT%\STEffect.aex" "%DIR%\plugins\" >nul
copy /Y "%OUT%\STBridge.aex" "%DIR%\plugins\" >nul
robocopy "%ROOT%\panel" "%DIR%\extension" /E /XF .debug demo.jpg .DS_Store >nul
robocopy "%ROOT%\out\engine\win-x64\st-engine" "%DIR%\extension\engine\win-x64\st-engine" /E >nul
copy /Y "%ROOT%\packaging\install-windows.bat" "%DIR%\" >nul
copy /Y "%ROOT%\packaging\README-release.txt" "%DIR%\README.txt" >nul
if exist "%ROOT%\LICENSE" copy /Y "%ROOT%\LICENSE" "%DIR%\LICENSE.txt" >nul
powershell -NoProfile -Command "Compress-Archive -Force -Path '%DIR%' -DestinationPath '%DIR%.zip'" || exit /b 1
echo Package: %DIR%.zip
