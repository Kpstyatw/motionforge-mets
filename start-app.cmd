@echo off
REM DYNMECH CycleView launcher
REM WorkBuddy (and some Electron-based hosts) inject ELECTRON_RUN_AS_NODE=1,
REM which makes electron.exe start in plain Node mode and crash with
REM "Cannot read properties of undefined (reading 'setName')".
REM Clearing it here guarantees a real Electron GUI launch.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
cd /d "%~dp0"

echo Starting DYNMECH CycleView...
call npm run electron
