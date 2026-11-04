@echo off
cd /d "%~dp0"
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call server.bat
