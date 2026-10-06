@echo off
rem Swarm Desk — one-click start for a 24/7 Windows computer.
rem Starts the app server in its own window, waits for it, then opens the app in the browser.
rem Trading resumes by itself if it was running before (until KILL is pressed).
cd /d "%~dp0"
start "Swarm Desk server (keep this window open)" cmd /k "npm run dev"
timeout /t 12 /nobreak >nul
start "" http://localhost:5173
