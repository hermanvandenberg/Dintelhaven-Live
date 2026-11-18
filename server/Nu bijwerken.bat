@echo off
rem Auteur: HvdB
rem Haalt meteen de nieuwste live versie van DintelLink op (de server doet dit
rem ook zelf elk kwartier). Mag terwijl de server draait.
title DintelLink bijwerken
cd /d "%~dp0.."
node server\dintellink-server.js --bijwerken
pause
