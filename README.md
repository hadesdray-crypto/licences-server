# Serveur de licences + boutique PayPal/Stripe + application d'administration

[![Déployer sur Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hadesdray-crypto/licences-server)

**Installation sans ordinateur** : cliquez sur le bouton ci-dessus (ou ouvrez <https://deploy.workers.cloudflare.com/?url=https://github.com/hadesdray-crypto/licences-server>), connectez votre compte Cloudflare et GitHub, confirmez : Cloudflare crée le serveur et sa base de données. Ouvrez ensuite `https://VOTRE-SERVEUR.workers.dev/admin` et choisissez votre mot de passe.

**Installation depuis un ordinateur** : double-cliquez sur `INSTALLER-WINDOWS.bat` (ou `INSTALLER-MAC.command`).


Système complet et gratuit pour **vendre vos applications** (Youpub et les suivantes) avec paiement unique,
accès limité dans le temps, protection contre le partage, et gestion depuis votre téléphone.

**👉 Installation : double-cliquez sur `INSTALLER-WINDOWS.bat` (ou `INSTALLER-MAC.command`)** — voir `LISEZ-MOI-D-ABORD.txt`, puis `GUIDE.md` pour le mode d'emploi complet.

## Ce que contient ce dossier

```
licences-server/
├── LISEZ-MOI-D-ABORD.txt     ← Les 3 gestes de l'installation
├── INSTALLER-WINDOWS.bat / INSTALLER-MAC.command        ← Installation en un double-clic
├── MISE-A-JOUR-WINDOWS.bat / MISE-A-JOUR-MAC.command    ← Mise à jour du serveur
├── GUIDE.md                  ← Guide d'installation et d'utilisation
├── README.md                 ← Ce fichier
├── package.json              ← Commandes : npm run setup / secrets / deploy / local / test
├── wrangler.toml             ← Configuration Cloudflare (remplie automatiquement par npm run setup)
├── schema.sql                ← Structure de la base de données
├── scripts/
│   ├── setup.mjs             ← Installation complète en une commande
│   ├── secrets.mjs           ← Configuration PayPal, emails, mot de passe
│   ├── dev-local.mjs         ← Serveur de test sur votre ordinateur, sans compte
│   └── test-local.mjs        ← 126 tests automatiques (npm test)
├── src/                      ← Le serveur (Cloudflare Worker)
│   ├── index.js              ← Routage des pages et de l'API
│   ├── admin.js              ← API d'administration (apps, licences, clients, finances, réglages, réserve)
│   ├── public.js             ← API utilisée par vos applications (activation, vérification, /go)
│   ├── paypal.js             ← PayPal : commandes, capture, webhook (paiement confirmé, remboursement)
│   ├── stripe.js             ← Carte bancaire : Stripe Checkout + webhook (paiement, remboursement)
│   ├── email.js              ← Envoi des clés par email (Brevo ou Resend)
│   ├── settings.js           ← Réglages modifiables depuis l'application (stockés en base)
│   ├── auth.js / crypto.js / db.js / util.js
│   └── ui/
│       ├── admin.html        ← Application d'administration (PWA, français, installable, hors ligne)
│       ├── buy.html          ← Page de vente avec bouton PayPal
│       ├── go.html           ← Page « J'ai un code » pour les clients
│       ├── order.html        ← Suivi d'une commande payée « à la main »
│       ├── receipt.html      ← Reçu imprimable
│       └── sw.js.txt, icônes
└── sdk/
    ├── licence-client.js     ← Module à intégrer dans une application web / Electron
    ├── licence_client.py     ← Module à intégrer dans une application Python
    └── INTEGRATION.md        ← Mode d'emploi + description de l'API pour tout autre langage
```

## Commandes

| Commande | Rôle |
|---|---|
| `npm install` | Installe les outils (une fois) |
| `npm run setup` | Crée le serveur gratuit, la base, le mot de passe, et déploie |
| `npm run secrets` | (Optionnel) Configure PayPal, les emails, le mot de passe depuis l'ordinateur — tout cela se fait aussi dans l'application |
| `npm run deploy` | Remet en ligne après une modification du code |
| `npm run local` | Lance une copie du serveur sur votre ordinateur (test sans compte) |
| `npm test` | Vérifie que tout fonctionne (126 tests) |
| `npm run logs` | Affiche les journaux du serveur en direct |

## Ce que fait l'application « Mes licences » (téléphone)

- **⚡ Vente rapide** : application → durée → prix → payé par (espèces, Lydia, virement…) → la clé s'affiche avec un message prêt à envoyer (lien de téléchargement + code + mode d'emploi) par SMS/WhatsApp/email.
- **Tous les moyens de paiement** : PayPal et carte bancaire (Stripe) automatiques ; virement, Lydia, Wero, PayPal entre proches, Revolut, espèces avec **validation par vous** (« Paiements à valider » → « Payé » → clé envoyée). Remboursement PayPal/Stripe → licence coupée.
- **Hors ligne** : l'application s'ouvre sans réseau avec les dernières données ; une **réserve de clés** permet de vendre sans connexion, la vente est synchronisée au retour du réseau.
- **Apps** : formules et prix, lien de téléchargement, **version** (les clients sont prévenus des mises à jour), page de vente à partager.
- **Licences** : recherche, filtres, prolonger, désactiver, appareils, client, prix, **reçu PDF**, renvoi par email.
- **Clients**, **Finances** (CA, frais PayPal estimés, net, par application/formule, meilleurs clients, **export CSV** pour le comptable), **Journal** (avec filtre erreurs).
- **Réglages** : PayPal, emails, coordonnées vendeur, mot de passe, nom de la boutique — tout depuis le téléphone, sans ordinateur.
- Plusieurs serveurs gérés depuis la même application.

## Fonctionnement

- **Clés** : `YOUPUB-AB12-CD34-EF56-GH78`, générées aléatoirement, liées à une application, une durée et un nombre d'appareils.
- **Durée** : le compte à rebours démarre à la **première activation** par le client (1 an acheté = 1 an d'utilisation, même s'il installe plus tard). Vous pouvez prolonger, raccourcir, passer à vie ou désactiver à tout moment.
- **Appareils** : chaque activation enregistre un identifiant d'appareil ; au-delà du nombre autorisé, refus. Vous pouvez retirer un appareil (le client a changé d'ordinateur).
- **Hors ligne** : l'application du client reçoit un jeton signé valable 7 jours ; elle revérifie en ligne une fois par jour. Une désactivation prend donc effet sous 7 jours maximum.
- **Paiement** : le prix est fixé côté serveur (impossible à modifier par le client), capturé via PayPal ou Stripe, puis la licence est créée et envoyée. Un remboursement désactive la licence automatiquement (webhooks signés). Les paiements manuels créent une commande que vous validez.
- **Premier lancement** : la base se crée toute seule et le mot de passe se choisit dans l'application ; `ADMIN_PASSWORD` (secret Cloudflare) sert de mot de passe de secours.
- **Sécurité** : mot de passe administrateur avec limitation des tentatives, sessions signées (HMAC-SHA256), secrets stockés chiffrés chez Cloudflare, aucune donnée bancaire ne transite par votre serveur (tout se passe chez PayPal).

## Limites du gratuit

Cloudflare : 100 000 requêtes/jour et 5 Go de données — suffisant pour des dizaines de milliers de clients.
Brevo : 300 emails/jour. PayPal : ~2,9 % + 0,35 € par vente ; Stripe : ~1,5 % + 0,25 €.
