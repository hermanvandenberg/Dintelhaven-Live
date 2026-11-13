@echo off
rem Auteur: HvdB
rem De server MET zichtbaar venster, om mee te kijken als er iets niet werkt.
rem Gewoon gebruik: het DintelLink-icoon op het bureaublad (zie Installeren.vbs).
title DintelLink-server
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is niet gevonden op deze laptop.
  echo  Installeer de LTS-versie van https://nodejs.org/ en start dit bestand opnieuw.
  echo.
  pause
  exit /b 1
)
set DINTELLINK_BEWAAKT=1
:start
node server\dintellink-server.js
rem Code 3 = bijgewerkt, 4 = herstarten vanuit de app: dan opnieuw starten.
if %errorlevel%==3 goto start
if %errorlevel%==4 goto start
echo.
echo  De server is gestopt.
pause
