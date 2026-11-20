@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

REM ============================================================
REM  DYNMECH CycleView - Windows NSIS installer one-click build
REM  Usage: double-click this file, or run: build-installer.bat
REM  Options: nocheck  - skip typecheck + tests
REM           nopause  - do not wait for a key (for automation / CI)
REM  Example: build-installer.bat nocheck nopause
REM
REM  Note: NSIS resources are cached by electron-builder after the
REM        first portable build. If the cache is missing, the first
REM        run needs internet access to download the NSIS toolchain.
REM ============================================================

cd /d "%~dp0"

REM --- switches ------------------------------------------------
set "RUN_CHECKS=1"
if /i "%~1"=="nocheck" set "RUN_CHECKS=0"
set "KEEP_TEMP=0"
set "NO_PAUSE=0"
if /i "%~1"=="nopause" set "NO_PAUSE=1"
if /i "%~2"=="nopause" set "NO_PAUSE=1"
REM Set KEEP_TEMP=1 above if you want to keep the intermediate build folder.

echo.
echo [1/6] Checking environment...
where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_node

if not exist "node_modules" (
  echo [ERROR] node_modules not found. Run "npm install" first.
  goto :fail
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Local Electron runtime not found: node_modules\electron\dist
  goto :fail
)
if not exist "node_modules\.bin\electron-builder.cmd" (
  echo [ERROR] electron-builder not found. Run "npm install" first.
  goto :fail
)

for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "VERSION=%%V"
if not defined VERSION goto :no_version

for /f "delims=" %%T in ('node -e "process.stdout.write(new Date().toISOString().replace(/[-:T.]/g,'').slice(0,14))"') do set "TS=%%T"
set "BUILD_OUT=release-build\installer-!TS!"
set "EXE_NAME=DYNMECH-CycleView-Setup-!VERSION!.exe"

echo       version = !VERSION!
echo       output  = !BUILD_OUT!\!EXE_NAME!

if "!RUN_CHECKS!"=="1" (
  echo.
  echo [2/6] Type check...
  call npm run typecheck
  if errorlevel 1 goto :fail

  echo.
  echo [3/6] Tests...
  call npm test
  if errorlevel 1 goto :fail
) else (
  echo.
  echo [2/6 + 3/6] Checks skipped by request.
)

echo.
echo [4/6] Building renderer + main process...
call npx vite build
if errorlevel 1 goto :fail
if not exist "dist\index.html" goto :no_dist

echo.
echo [5/6] Packing NSIS installer (local Electron)...
call npx electron-builder --win nsis ^
  -c.electronDist="%~dp0node_modules\electron\dist" ^
  -c.directories.output="!BUILD_OUT!"
if errorlevel 1 goto :fail

if not exist "!BUILD_OUT!\!EXE_NAME!" goto :no_exe

echo.
echo [6/6] Copying to release\ ...
if not exist "release" mkdir "release"
copy /Y "!BUILD_OUT!\!EXE_NAME!" "release\!EXE_NAME!" >nul
if errorlevel 1 goto :fail

if "!KEEP_TEMP!"=="0" (
  rmdir /s /q "!BUILD_OUT!" 2>nul
  echo       temporary build folder removed.
) else (
  echo       temporary build folder kept: !BUILD_OUT!
)

echo.
echo ============================================================
echo  DONE: release\!EXE_NAME!
echo  NSIS installer: per-user install, optional desktop shortcut.
echo ============================================================
echo.
if "!NO_PAUSE!"=="0" pause
endlocal
exit /b 0

:no_node
echo [ERROR] Node.js / npm not found in PATH.
goto :fail

:no_version
echo [ERROR] Could not read version from package.json.
goto :fail

:no_dist
echo [ERROR] Build finished but dist\index.html is missing.
goto :fail

:no_exe
echo [ERROR] electron-builder finished but installer is missing:
echo        !BUILD_OUT!\!EXE_NAME!
echo        Check the log above. If the NSIS toolchain was not cached yet,
echo        the first run needs internet access to download it. If the
echo        output folder was locked, set KEEP_TEMP=1 and run again.
goto :fail

:fail
echo.
echo [FAILED] Packaging aborted. See the messages above.
echo.
if "!NO_PAUSE!"=="0" pause
endlocal
exit /b 1
