@echo off
rem Startet den Server und macht ihn ueber einen Cloudflare-Tunnel oeffentlich erreichbar.
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul

if not exist "tools\cloudflared.exe" (
  echo cloudflared fehlt - lade es von github.com/cloudflare/cloudflared ...
  powershell -NoProfile -Command "New-Item -ItemType Directory -Force tools | Out-Null; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile tools\cloudflared.exe"
)

start "HugoSMP Live - Server" cmd /c server.bat

echo.
echo   Gleich erscheint unten ein Kasten mit der oeffentlichen Adresse:
echo   https://....trycloudflare.com  - die kannst du teilen.
echo.
echo   Dieses Fenster offen lassen. Schliessen = Seite nicht mehr oeffentlich.
echo   Die Accountliste kannst du nur hier am PC unter http://localhost:3000 aendern.
echo.
tools\cloudflared.exe tunnel --no-autoupdate --url http://localhost:3000
pause
