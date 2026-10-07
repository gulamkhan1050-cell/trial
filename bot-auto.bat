@echo off
rem Swarm Desk bot - fully automatic on a Windows computer. Double-click once; after that it:
rem   * starts by itself whenever you log in to Windows,
rem   * downloads the latest version (git pull) every 6 hours and restarts on it,
rem   * restarts after a crash or a network drop.
rem Orders and positions stay on Binance across every restart and are picked back up.
rem It stops for good only on the kill switch / loss limit or bad keys. Close this window to stop it.
cd /d "%~dp0"

rem Start with Windows (once): a small launcher in your Startup folder.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\swarmdesk-bot.bat"
if not exist "%STARTUP%" (
  > "%STARTUP%" echo @echo off
  >> "%STARTUP%" echo start "Swarm Desk bot" /min "%~f0"
  echo Added to Windows startup: the bot will start by itself after every login.
)

set BOT_RESTART_HOURS=6
:loop
echo.
echo [%date% %time%] checking for updates...
git pull --ff-only
call npm install --no-audit --no-fund --loglevel=error
call npx vite build --ssr bot/bot.ts --outDir dist-bot --emptyOutDir --logLevel warn
node dist-bot/bot.js
set CODE=%errorlevel%
if "%CODE%"=="0" goto stopped
if "%CODE%"=="2" goto bad_keys
if "%CODE%"=="3" goto killed
if "%CODE%"=="5" goto twice
echo [%date% %time%] bot exited (%CODE%) - restarting in 15 s
timeout /t 15 /nobreak >nul
goto loop

:stopped
echo Stopped by you. Orders and positions stay on Binance; run this again to resume.
exit /b 0
:bad_keys
echo The API key was rejected. Fix bot.config.json (or delete it to be asked again), then run this again.
pause
exit /b 2
:killed
echo Kill switch or loss limit fired - everything was closed. Check Binance, then run this again to restart.
pause
exit /b 3
:twice
echo Another bot window is already running - this one closes so they don't fight over your orders.
timeout /t 10 >nul
exit /b 5
