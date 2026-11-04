@echo off
rem Startet nur den Server (ohne Browser, ohne Tunnel). Installiert fehlende Pakete beim ersten Mal.
cd /d "%~dp0"
title HugoSMP Live - Server
if not exist ".env" copy ".env.example" ".env" >nul
if not exist "node_modules\tesseract.js" (
  echo Installiere Pakete fuer die Bilderkennung ...
  call npm install --no-audit --no-fund
)
node server.js
pause
