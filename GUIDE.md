# Guide – Serveur de licences, boutique PayPal et application « Mes licences »

Ce guide vous emmène de zéro à « je vends Youpub et je gère tout depuis mon téléphone ».
**Une seule étape se fait sur l'ordinateur : l'installation, en un double-clic (~10 minutes). Tout le reste se fait depuis l'application sur votre téléphone.** Tout est gratuit, sauf les commissions PayPal/Stripe sur vos ventes en ligne par carte ou PayPal.

> Si vous bloquez sur une étape, copiez-moi le message affiché à l'écran : je vous dépanne.

---

## Vue d'ensemble

```
Vous êtes avec la personne  →  ⚡ Vente rapide dans l'app  →  code + lien envoyés par SMS/WhatsApp  →  réglé
Vente en ligne              →  page de vente (/buy/youpub) → PayPal/carte → clé affichée + email  →  réglé
Le client                   →  télécharge Youpub, colle le code, l'application se débloque
Vous                        →  tout gérer : ventes, clients, durées, finances, reçus, réglages… depuis le téléphone
```

| Brique | Service | Coût |
|---|---|---|
| Serveur + base de données | Cloudflare Workers + D1 | Gratuit (100 000 requêtes/jour, 5 Go) |
| Paiement en ligne automatique | PayPal Business et/ou Stripe (carte, Apple Pay, Google Pay) | Gratuit, ~2,9 % + 0,35 € (PayPal) ou ~1,5 % + 0,25 € (Stripe) par vente |
| Paiements « à la main » | Virement, Lydia, Wero, PayPal entre proches, Revolut, espèces — vous validez dans l'app | 0 € |
| Emails automatiques | Brevo | Gratuit (300 emails/jour) |
| Application d'administration | Servie par votre serveur, installable sur le téléphone, fonctionne hors ligne | Gratuit |

---

## Partie A – Installation (une fois, sur l'ordinateur)

### A1. Le dossier
Décompressez `licences-server.zip` quelque part (ex : `Documents/licences-server`). Rien d'autre à installer : le programme d'installation s'occupe de Node.js (l'outil gratuit dont il a besoin).

### A2. Compte Cloudflare (gratuit)
Créez un compte sur <https://dash.cloudflare.com/sign-up> (email + mot de passe, aucune carte bancaire) et confirmez votre email.

### A3. Installation en un double-clic
Dans le dossier décompressé, double-cliquez sur :
- **Windows** : `INSTALLER-WINDOWS.bat`
- **Mac** : `INSTALLER-MAC.command` *(si macOS refuse : clic droit → Ouvrir → Ouvrir)*

Le programme :
- installe **Node.js** tout seul s'il manque (sur Windows via le magasin intégré ; sinon il ouvre la page de téléchargement, installez puis relancez) ;
- ouvre votre navigateur pour autoriser l'accès à votre compte Cloudflare (cliquez **Autoriser**) ;
- vous demande un **nom de serveur** (gardez `licences`) et un **nom affiché** (ex : `Boutique Youpub`) ;
- crée la base de données, met le serveur en ligne et **ouvre l'application** dans votre navigateur.

*Première fois sur Cloudflare : il peut vous demander de choisir un « sous-domaine workers.dev » (ex : votre prénom). Tapez-le et validez.*

### A3 bis. Votre mot de passe
Dans la page qui s'ouvre (« Bienvenue 👋 »), **choisissez votre mot de passe administrateur**. Faites-le tout de suite après l'installation : tant qu'aucun mot de passe n'existe, la première personne qui ouvre la page peut le créer.

*(Vous préférez le terminal ? `npm install` puis `npm run setup` font la même chose.)*

### A4. L'application sur votre téléphone
1. Sur le téléphone, ouvrez `https://licences.VOTRE-NOM.workers.dev/admin` dans **Chrome** (Android) ou **Safari** (iPhone) (l'adresse exacte est affichée à la fin de l'installation).
2. Connectez-vous avec le mot de passe que vous venez de choisir.
3. Ajoutez-la à l'écran d'accueil :
   - **Android** : menu ⋮ → **Installer l'application** (ou « Ajouter à l'écran d'accueil »).
   - **iPhone** : bouton **Partager** (carré avec flèche) → **Sur l'écran d'accueil**.

Elle s'ouvre désormais comme une vraie application, en plein écran, et **s'ouvre même sans réseau** (elle affiche les dernières données connues).

**C'est fini pour l'ordinateur.** Vous n'y revenez que si je vous envoie une nouvelle version du code : remplacez les fichiers et double-cliquez sur `MISE-A-JOUR-WINDOWS.bat` / `MISE-A-JOUR-MAC.command`.

---

## Partie B – Tout se passe dans l'application

### B1. Créer votre application à vendre (Youpub)
Onglet **Apps** → **+ Ajouter** :
- **Nom** : Youpub.
- **Lien de téléchargement** : l'adresse où le client télécharge Youpub (Google Drive, Dropbox, GitHub Releases, votre site…). Il est inclus dans le message envoyé au client et dans l'email après paiement.
- **Version actuelle** : ex. `1.0.0`. Plus tard, quand vous publiez une nouvelle version, changez ce numéro (et le lien si besoin) : les clients voient « Nouvelle version disponible » dans Youpub.
- **Appareils autorisés** : 2 (le client peut utiliser sa clé sur 2 ordinateurs ; au 3e, c'est refusé).
- **Formules** : ex. `1 an – 29,99 €`, `6 mois – 17,99 €`, `À vie – 79 €`. Elles servent sur la page de vente **et** de raccourcis dans Vente rapide.

Appuyez sur **Enregistrer**. Votre page de vente est prête : `https://licences.VOTRE-NOM.workers.dev/buy/youpub`.

### B2. Vendre quand vous êtes avec la personne (le cas le plus simple)
Accueil → **⚡ Vente rapide** :
1. Choisissez l'application (si vous en avez plusieurs) et la durée : une de vos formules, ou **Autre…** pour une durée et un prix libres.
2. Indiquez le **prix encaissé** (pour vos statistiques et le reçu), **par quel moyen** (espèces, virement, Lydia, Wero, PayPal, Revolut…) et, si vous voulez, l'email du client.
3. **Générer la clé** → la clé s'affiche en grand, avec un message tout prêt :
   > Votre accès à Youpub · Code : YOUPUB-XXXX-… · 1) Téléchargez : <lien> · 2) Ouvrez l'application et collez le code.
4. **📤 Envoyer au client** → SMS, WhatsApp, email… au choix. La personne télécharge, colle le code, c'est réglé. Elle est débloquée pour la durée choisie à partir du moment où elle active.

Vous encaissez comme vous voulez (espèces, virement, PayPal entre amis…).

### B3. Vendre sans réseau
L'application s'ouvre hors ligne et affiche vos données. Pour vendre sans connexion, préparez des clés à l'avance : **Plus → Réserve de clés → Préparer** (par exemple 10 clés « Youpub · 1 an »). Elles sont enregistrées sur le serveur et mémorisées dans le téléphone. Hors ligne, **Vente rapide** en prend une automatiquement ; la vente (prix, client) est synchronisée dès que le réseau revient (bandeau en haut de l'écran). Le client, lui, active sa clé normalement.

### B4. Vendre en ligne, automatiquement (PayPal)
Pour que les gens paient seuls sur votre page de vente :

1. **Compte PayPal Business** (gratuit ; un compte personnel se convertit) : <https://www.paypal.com/fr/business>.
2. Sur <https://developer.paypal.com/dashboard/applications> : choisissez **Sandbox** (tests avec de faux paiements) ou **Live** (réel) → **Create App** → copiez le **Client ID** et le **Secret**.
3. Dans l'application → **Plus → Réglages → PayPal** : mode, Client ID, Secret → **Enregistrer et tester**. Le badge doit indiquer « fonctionne ».
4. **Webhook** (recommandé : confirme un paiement même si le client ferme la page, et **désactive la licence en cas de remboursement**) : dans votre app PayPal → **Add Webhook**, collez l'adresse affichée dans Réglages (bouton Copier), cochez *Checkout order approved*, *Payment capture completed*, *Payment capture refunded*, *Payment capture reversed*. Copiez le **Webhook ID** dans Réglages.
5. Testez en Sandbox avec un compte acheteur fictif (<https://developer.paypal.com/dashboard/accounts>), puis passez en **Live** avec les identifiants Live (ils sont différents).
6. Partagez votre page de vente (bouton **Partager la page de vente** dans Apps) : message, site, plateformes, réseaux. Le client paie avec PayPal ou sa carte, voit sa clé immédiatement et la reçoit par email.

### B4 bis. Carte bancaire via Stripe (facultatif)
PayPal accepte déjà la carte sans compte PayPal. Stripe ajoute Apple Pay / Google Pay et des frais plus bas (~1,5 % + 0,25 €).
1. Compte sur <https://dashboard.stripe.com/register> (gratuit ; activez-le pour encaisser en réel).
2. **Développeurs → Clés API** : copiez la **clé secrète** (`sk_test_…` pour tester, `sk_live_…` pour le réel).
3. **Développeurs → Webhooks → Ajouter un point de terminaison** : collez l'adresse affichée dans **Réglages → Stripe**, événements `checkout.session.completed` et `charge.refunded`, copiez le **secret de signature** (`whsec_…`).
4. **Réglages → Carte bancaire via Stripe** : collez les deux → **Enregistrer et tester**. Le bouton « Payer par carte bancaire » apparaît sur votre page de vente. Un remboursement coupe la licence automatiquement.

### B4 ter. Virement, Lydia, Wero, PayPal entre proches, Revolut, espèces… (validation par vous)
**Réglages → Autres moyens de paiement** : cochez ceux que vous acceptez et indiquez vos coordonnées (IBAN, numéro Lydia…). Ensuite :
1. Sur votre page de vente, le client choisit par exemple « Virement », donne son email et reçoit vos consignes + une **référence** (`CMD-XXXXXX`) + une page de suivi.
2. Vous recevez un email « À valider » (si votre email de contact est renseigné dans Réglages → Vendeur) et la commande apparaît sur l'**Accueil** → **Paiements à valider**.
3. L'argent est arrivé ? Appuyez sur **✅ Payé, envoyer la clé** : la clé est créée, envoyée par email au client, et s'affiche sur sa page de suivi. Vous pouvez aussi la lui envoyer par SMS/WhatsApp d'un geste.
4. Pas d'argent ? **Annuler** (réouvrable depuis l'historique).

### B5. Emails automatiques (Brevo, gratuit)
Sans cette étape, le client voit sa clé à l'écran après paiement mais ne la reçoit pas par email, et la vente rapide ne peut pas l'envoyer par email (le SMS/WhatsApp fonctionne quand même).

1. Compte gratuit sur <https://www.brevo.com>.
2. **Expéditeurs** → ajoutez votre adresse email et confirmez-la.
3. Votre nom (en haut à droite) → **SMTP & API** → **Clés API** → **Générer** → copiez la clé.
4. Dans l'application → **Réglages → Emails automatiques** : clé, adresse expéditrice, nom → **Enregistrer**, puis **Envoyer un email de test**.

### B6. Vos coordonnées (reçus / factures)
**Réglages → Vendeur** : nom, adresse, SIRET, mention TVA (par défaut « TVA non applicable, art. 293 B du CGI », le cas des micro-entrepreneurs). Ensuite, sur chaque licence, le bouton **🧾 Reçu** génère un reçu imprimable (PDF) que vous pouvez envoyer au client.

### B7. Intégrer la licence dans Youpub
Deux modules prêts à l'emploi sont dans le dossier `sdk/` (JavaScript et Python), avec le mode d'emploi dans `sdk/INTEGRATION.md`.

**Le plus simple : envoyez-moi le code de Youpub (ou dites-moi dans quel langage il est écrit) et je fais l'intégration.**

Ce que fait le module dans Youpub :
- Au premier lancement : fenêtre « Activation requise » → le client colle son code → débloqué.
- Ensuite : vérification silencieuse une fois par jour ; fonctionne 7 jours sans Internet.
- Licence expirée ou désactivée par vous → Youpub se rebloque et redemande un code.
- Nouvelle version publiée dans l'app → le client voit « Nouvelle version disponible » avec le lien.

### B8. Essai gratuit (« testez 3 jours, puis payez »)
Dans la fiche de l'application (Apps → Modifier), réglez **« Essai gratuit (jours) »** sur 3 (ou le nombre que vous voulez ; 0 = pas d'essai). À partir de là :
- La page de vente affiche une carte « 🎁 Essai gratuit : 3 jours » avec le bouton **Télécharger l'application** (le lien de téléchargement devient public, c'est voulu : c'est l'essai qui attire les clients).
- Au premier lancement, l'application propose **« Essayer gratuitement 3 jours »** à côté de la saisie du code. Un clic suffit, aucun code à taper.
- Pendant l'essai, l'application fonctionne normalement et rappelle les jours restants.
- Au bout des 3 jours, elle se bloque avec le message « Votre période d'essai gratuit est terminée. Achetez une licence pour continuer. » et le lien vers votre page de vente. Le client achète, colle son code, c'est reparti — sans rien réinstaller.
- **Un seul essai par appareil** : impossible d'enchaîner les essais sur le même téléphone/ordinateur. (Une personne qui efface complètement les données de l'application ou change d'appareil peut en relancer un ; pour 3 jours, ce n'est pas un enjeu — le serveur limite en plus les demandes d'essai par adresse IP.)
- Dans l'app d'administration : les essais apparaissent dans **Licences → Essais** (badge « Essai »), l'accueil affiche « X essais en cours », et ils ne comptent jamais dans vos ventes, vos finances ni l'export comptable.

---

## Au quotidien (depuis le téléphone)

| Je veux… | Où |
|---|---|
| Vendre à quelqu'un devant moi | **Accueil → ⚡ Vente rapide** |
| Voir mes ventes, ce qui expire bientôt, les erreurs | **Accueil** |
| Valider un virement / Lydia / Wero reçu et envoyer la clé | **Accueil → Paiements à valider** (ou Plus → Paiements à valider) |
| Chiffre d'affaires, frais PayPal, net, export pour le comptable | **Plus → Finances** (bouton **Exporter en CSV**) |
| Changer un prix, une durée, le lien de téléchargement, la version | **Apps → Modifier** |
| Un client a changé d'ordinateur | **Licences** → sa licence → **Retirer** l'ancien appareil |
| Offrir du temps à un client | sa licence → **+30 jours** / **+1 an** / date libre |
| Couper l'accès (impayé, abus) | sa licence → **Désactiver la licence** |
| Un client a perdu son code | sa licence → **Envoyer la clé par email**, ou il va sur la page **/go** (« J'ai un code ») |
| Faire un reçu | sa licence → **🧾 Reçu** |
| Retrouver un client | **Clients** → rechercher |
| Vérifier PayPal / email, changer le mot de passe | **Plus → Réglages** |
| Préparer des clés pour vendre sans réseau | **Plus → Réserve de clés** |
| Voir tout ce qui s'est passé | **Plus → Journal d'activité** (filtre « Erreurs seulement ») |

**Mettre à jour Youpub** : remplacez le fichier derrière votre lien de téléchargement, puis Apps → Modifier → nouveau numéro de version. Les codes restent valables, les clients sont prévenus.

**Mise à jour de l'application « Mes licences »** : automatique, dès que le serveur est redéployé.

## Plusieurs serveurs
Un seul serveur gratuit suffit très largement (100 000 requêtes/jour = des dizaines de milliers de clients). Pour séparer des activités : sur l'ordinateur, `npm run setup -- --name licences-2` crée un second serveur indépendant ; ajoutez-le dans **Plus → Serveurs**. Pour une nouvelle limite gratuite (autre compte Cloudflare) : `npx wrangler logout` puis `npm run setup -- --name licences-2`.

## Mettre à jour le serveur
Quand je vous enverrai une nouvelle version du code : remplacez les fichiers, puis dans le terminal :
```
npm run deploy
```
Vos données (licences, clients, réglages) sont dans la base, jamais dans le code : rien n'est perdu.

## Essayer sans compte (optionnel)
```
npm run local
```
puis <http://localhost:8787/admin> (mot de passe `test1234`). Nécessite Node.js 22.5+. `npm test` lance les 126 tests automatiques.

## Sécurité : ce qu'il faut savoir honnêtement
- **Partage de code** : bloqué par la limite d'appareils (2 par défaut). Un code diffusé sur un forum ne sert qu'aux 2 premiers.
- **Fin de validité / désactivation** : effective sous 7 jours maximum, même si l'appareil reste hors ligne.
- **Copie du logiciel** : Youpub est installé chez le client ; quelqu'un de très compétent peut modifier le programme pour sauter la vérification. Aucun système de licence n'empêche ça à 100 % pour un logiciel installé. Pour une protection totale, la partie précieuse doit tourner sur votre serveur (version web). On pourra en parler pour Youpub.
- **Vos réglages sensibles** (secret PayPal, clé Brevo) sont stockés dans votre base Cloudflare, jamais renvoyés à l'écran, protégés par votre mot de passe administrateur (10 essais par heure maximum).
- Choisissez un mot de passe long et ne le partagez pas. Changement : Réglages → Mot de passe.

## Côté administratif (France)
Pour encaisser régulièrement, il faut un statut : la **micro-entreprise** est la plus simple (création gratuite sur <https://www.autoentrepreneur.urssaf.fr>, déclaration du chiffre d'affaires chaque mois ou trimestre — l'export CSV de Finances vous donne les chiffres). Prévoyez des **conditions générales de vente** sur votre page (je peux vous les rédiger). Je ne suis ni comptable ni juriste : un rendez-vous rapide avec un expert-comptable ou la CCI lève toutes les questions (TVA, facturation).

## En cas de problème
| Symptôme | Solution |
|---|---|
| `npm` ou `node` : commande introuvable | Node.js n'est pas installé, ou rouvrez le terminal après installation |
| « Mot de passe incorrect » / mot de passe perdu | Réglages → Mot de passe (si connecté). Sinon, sur l'ordinateur : `npm run secrets` → 3 → **b** efface le mot de passe de l'application, vous le recréez au prochain lancement |
| « Trop de tentatives » | Attendez 1 heure (protection anti-piratage) |
| PayPal « échec » dans Réglages | Client ID **et** Secret du **même** mode (sandbox/live) ? Réessayez « Enregistrer et tester » |
| Bouton PayPal absent sur la page de vente | Bloqueur de pub ? PayPal configuré et « fonctionne » dans Réglages ? |
| Email non envoyé (erreur dans le Journal) | Adresse expéditrice **vérifiée** chez Brevo ? Clé complète ? Réglages → Envoyer un email de test |
| « Base non initialisée » | Normalement impossible (les tables se créent toutes seules) ; sinon `npm run db:init` sur l'ordinateur |
| Bandeau « Hors ligne » alors que j'ai du réseau | Le serveur est peut-être inaccessible : réessayez, puis vérifiez sur <https://dash.cloudflare.com> |
| Autre | Copiez-moi le message d'erreur exact |
