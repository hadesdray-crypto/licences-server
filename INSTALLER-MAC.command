#!/bin/bash
# Installation du serveur de licences (Mac). Double-cliquez sur ce fichier.
# Si macOS refuse de l'ouvrir : clic droit → Ouvrir → Ouvrir.
cd "$(dirname "$0")"
echo
echo " =================================================="
echo "   Installation du serveur de licences"
echo " =================================================="
echo
echo " Ce programme va :"
echo "  1. installer Node.js si besoin (outil gratuit),"
echo "  2. vous connecter à votre compte Cloudflare (gratuit) dans le navigateur,"
echo "  3. mettre votre serveur en ligne,"
echo "  4. ouvrir l'application pour que vous choisissiez votre mot de passe."
echo

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo " Node.js n'est pas installé. Installation avec Homebrew..."
    brew install node
  else
    echo " Node.js n'est pas installé."
    echo " Une page va s'ouvrir : installez Node.js (bouton vert, « LTS »), puis relancez ce fichier."
    open "https://nodejs.org"
    read -n 1 -s -r -p " Appuyez sur une touche pour fermer."
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  echo " Installation des outils (une seule fois, 1 à 2 minutes)..."
  npm install --no-fund --no-audit --loglevel=error || { echo " L'installation des outils a échoué. Vérifiez votre connexion Internet puis relancez."; read -n 1 -s -r; exit 1; }
  echo
fi

npm run setup
echo
echo " --------------------------------------------------"
read -n 1 -s -r -p " Vous pouvez fermer cette fenêtre (appuyez sur une touche)."
echo
