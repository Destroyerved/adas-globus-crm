@echo off
rem Double-click to run the CRM on this Windows PC (needs Node.js 22.13 or newer from nodejs.org)
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev
)
start "" http://localhost:3000
call npm start
pause
