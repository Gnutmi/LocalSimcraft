@echo off
REM ============================================================
REM  LocalSimcraft launcher
REM  Double-click this to start the server. Edit SIMC_PATH below
REM  if your SimulationCraft install is somewhere else.
REM ============================================================

REM --- config (edit if needed) --------------------------------
set "SIMC_PATH=I:\Simulationcraft\simc.exe"
set "PORT=3737"
set "HOST=0.0.0.0"

REM --- always run from this script's folder, no matter where
REM     it was launched from (e.g. a Start Menu shortcut) -----
cd /d "%~dp0"

title LocalSimcraft

echo.
echo  LocalSimcraft
echo  -------------
echo  SimC:    %SIMC_PATH%
echo  Listen:  http://localhost:%PORT%
echo.

REM --- sanity checks ------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo  [!] Node.js was not found on PATH.
    echo      Install it from https://nodejs.org/ ^(LTS^), then re-run.
    echo.
    pause
    exit /b 1
)

if not exist "%SIMC_PATH%" (
    echo  [!] simc.exe not found at:
    echo      %SIMC_PATH%
    echo      Edit SIMC_PATH at the top of start.cmd to point at your install.
    echo.
    pause
    exit /b 1
)

REM --- first-run install --------------------------------------
if not exist "node_modules" (
    echo  First run detected. Installing dependencies...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [!] npm install failed. Check the output above.
        pause
        exit /b 1
    )
    echo.
)

REM --- go ------------------------------------------------------
node server.js

REM If the server exits ^(crash, Ctrl+C^), keep the window open so
REM you can read any error message before it disappears.
echo.
echo  Server stopped.
pause
