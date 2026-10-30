@echo off
chcp 65001 >nul 2>&1
title Installation du serveur de licences
cd /d "%~dp0"
echo.
echo  ==================================================
echo    Installation du serveur de licences
echo  ==================================================
echo.
echo  Ce programme va :
echo   1. installer Node.js si besoin (outil gratuit),
echo   2. vous connecter a votre compte Cloudflare (gratuit) dans le navigateur,
echo   3. mettre votre serveur en ligne,
echo   4. ouvrir l'application pour que vous choisissiez votre mot de passe.
echo.
echo  Vous n'avez rien a taper d'autre que ce qui vous est demande.
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  Node.js n'est pas installe. Installation automatique (1 a 3 minutes)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LocalAppData%\Programs\nodejs"
  where node >nul 2>nul
  if %errorlevel% neq 0 (
    echo.
    echo  Node.js n'a pas pu etre installe automatiquement.
    echo  Une page va s'ouvrir : installez Node.js (bouton vert, "LTS"), puis relancez ce fichier.
    start https://nodejs.org
    echo.
    pause
    exit /b 1
  )
  echo  Node.js installe.
  echo.
)

if not exist node_modules (
  echo  Installation des outils (une seule fois, 1 a 2 minutes)...
  call npm install --no-fund --no-audit --loglevel=error
  if %errorlevel% neq 0 (
    echo.
    echo  L'installation des outils a echoue. Verifiez votre connexion Internet puis relancez.
    pause
    exit /b 1
  )
  echo.
)

call npm run setup
echo.
echo  --------------------------------------------------
echo  Vous pouvez fermer cette fenetre.
pause
