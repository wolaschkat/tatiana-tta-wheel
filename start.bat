@echo off
rem TATIANA TTA WHEEL - one-click start: wheel server + ngrok tunnel + admin page.
rem Keep the two windows it opens running for the whole stream; close them to stop.
title TATIANA TTA WHEEL - starting
cd /d "%~dp0"

set "NGROK=C:\Users\tatia\ngrok\ngrok.exe"
set "PUBLIC_URL="
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PUBLIC_URL=" .env') do set "PUBLIC_URL=%%b"

rem 1) Wheel server (skipped if it is already running on port 3000)
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if errorlevel 1 (
  start "TTA Wheel - SERVER (keep open)" cmd /k node server.js
) else (
  echo Wheel server is already running.
)

rem 2) ngrok tunnel, so Kick can reach the app (skipped if ngrok is already running)
tasklist /fi "imagename eq ngrok.exe" | find /i "ngrok.exe" >nul
if errorlevel 1 (
  if defined PUBLIC_URL (
    start "TTA Wheel - NGROK (keep open)" "%NGROK%" http 3000 --url=%PUBLIC_URL%
  ) else (
    echo PUBLIC_URL is missing in .env - Kick will not work until it is set.
  )
) else (
  echo ngrok is already running.
)

rem 3) Wait for the server (up to ~20 s), then open the admin page
set /a tries=0
:wait
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 goto open
set /a tries+=1
if %tries% geq 20 (
  echo The wheel server did not start. Check the SERVER window for the error.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:open
for /f "usebackq delims=" %%t in (`node -p "require('./data/secrets.json').adminToken"`) do set "ADMIN_TOKEN=%%t"
start "" "http://127.0.0.1:3000/#token=%ADMIN_TOKEN%"
exit /b 0
