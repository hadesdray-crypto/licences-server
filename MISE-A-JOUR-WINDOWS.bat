@echo off
chcp 65001 >nul 2>&1
title Mise a jour du serveur de licences
cd /d "%~dp0"
echo.
echo  Mise a jour du serveur en ligne (vos donnees ne sont pas touchees)...
echo.
set "PATH=%PATH%;%ProgramFiles%\nodejs"
if not exist node_modules call npm install --no-fund --no-audit --loglevel=error
call npm run deploy
echo.
echo  Termine. L'application sur votre telephone se met a jour toute seule.
pause
