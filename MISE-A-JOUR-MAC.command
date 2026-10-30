#!/bin/bash
# Remet le serveur en ligne après une mise à jour du code (vos données ne sont pas touchées).
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-fund --no-audit --loglevel=error
npm run deploy
echo
read -n 1 -s -r -p " Terminé. L'application sur votre téléphone se met à jour toute seule. (appuyez sur une touche)"
echo
