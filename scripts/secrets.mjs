#!/usr/bin/env node
// Configuration de PayPal, des emails et du mot de passe :  npm run secrets

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  ask, closePrompt, title, ok, warn, fail, wrangler, readToml, writeToml, getVar, setVar, getTop, putSecret, ensureLoggedIn, ensureDeps, deploy,
} from './common.mjs';

ensureDeps();
ensureLoggedIn();

let toml = readToml();
if (!/database_id\s*=\s*"[0-9a-f-]{36}"/.test(toml) && !fs.existsSync(new URL('../.server-info.json', import.meta.url))) {
  fail('Le serveur n\'est pas encore installé depuis cet ordinateur. Lancez d\'abord : npm run setup (ou configurez tout depuis l\'application).');
  closePrompt();
  process.exit(1);
}
let varsChanged = false;

async function paypal() {
  title('PayPal');
  console.log(`Où trouver ces informations :
  1. Créez un compte PayPal Business (gratuit) : https://www.paypal.com/fr/business
  2. Allez sur https://developer.paypal.com/dashboard/applications  → « Create App »
  3. Choisissez « Sandbox » pour tester avec de faux paiements, ou « Live » pour les vrais.
  4. Copiez le « Client ID » et le « Secret » de l'application.
`);
  const env = (await ask('Mode : sandbox (test) ou live (réel) ?', getVar(toml, 'PAYPAL_ENV') || 'sandbox')).toLowerCase() === 'live' ? 'live' : 'sandbox';
  const clientId = await ask('Client ID PayPal', getVar(toml, 'PAYPAL_CLIENT_ID'));
  const secret = await ask('Secret PayPal (vide = ne pas changer)');
  toml = setVar(toml, 'PAYPAL_ENV', env);
  toml = setVar(toml, 'PAYPAL_CLIENT_ID', clientId);
  varsChanged = true;
  if (secret) putSecret('PAYPAL_SECRET', secret);

  const name = getTop(toml, 'name');
  console.log(`
Webhook (recommandé : confirme les paiements même si le client ferme la page, et désactive la licence en cas de remboursement) :
  1. Dans votre application PayPal (developer.paypal.com), section « Webhooks » → « Add Webhook ».
  2. URL :  https://${name}.<votre-sous-domaine>.workers.dev/api/paypal/webhook
     (l'adresse exacte est affichée dans l'application, écran Réglages)
  3. Événements à cocher : « Checkout order approved », « Payment capture completed », « Payment capture refunded », « Payment capture reversed ».
  4. Copiez le « Webhook ID » affiché.
`);
  const wh = await ask('Webhook ID (vide = plus tard)');
  if (wh) putSecret('PAYPAL_WEBHOOK_ID', wh);
  warn(`Attention : les identifiants Sandbox et Live sont différents. En passant en mode « live », refaites cette étape avec les identifiants Live.`);
}

async function email() {
  title('Emails (envoi automatique des clés)');
  console.log(`Fournisseurs gratuits :
  • Brevo (recommandé, 300 emails/jour) : https://www.brevo.com  → compte gratuit → « Expéditeurs » : ajoutez et vérifiez votre adresse
    → « SMTP & API » → « Clés API » → créer une clé.
  • Resend (3 000 emails/mois) : https://resend.com — nécessite un nom de domaine à vous.
`);
  const provider = (await ask('Fournisseur : brevo ou resend ?', 'brevo')).toLowerCase() === 'resend' ? 'resend' : 'brevo';
  const key = await ask(`Clé API ${provider} (vide = ne pas changer)`);
  if (key) putSecret(provider === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY', key);
  const from = await ask('Adresse email expéditrice (vérifiée chez le fournisseur)', getVar(toml, 'EMAIL_FROM'));
  const fromName = await ask('Nom de l\'expéditeur', getVar(toml, 'EMAIL_FROM_NAME') || getVar(toml, 'APP_NAME'));
  toml = setVar(toml, 'EMAIL_FROM', from);
  toml = setVar(toml, 'EMAIL_FROM_NAME', fromName);
  varsChanged = true;
}

async function password() {
  title('Mot de passe administrateur');
  console.log(`Normalement, le mot de passe se gère dans l'application (Réglages). Ici vous pouvez :
  a. définir un mot de passe de SECOURS (secret Cloudflare), toujours accepté en plus de celui de l'application
  b. effacer le mot de passe de l'application (vous le recréerez au prochain lancement) – si vous l'avez perdu`);
  const c = (await ask('Votre choix (a/b)', 'a')).toLowerCase();
  if (c === 'b') {
    const db = toml.match(/database_name\s*=\s*"([^"]+)"/)[1];
    const r = wrangler(['d1', 'execute', db, '--remote', '--command', "DELETE FROM settings WHERE key='admin_password_hash'", '--yes']);
    if (r.status === 0) ok('Mot de passe de l\'application effacé : ouvrez l\'application et créez-en un nouveau.'); else fail(r.out);
    return;
  }
  let pw = '';
  while (pw.length < 8) {
    pw = await ask('Mot de passe de secours (8 caractères minimum, vide = en générer un)');
    if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); console.log(`Mot de passe généré : \x1b[1m${pw}\x1b[0m  (notez-le !)`); }
  }
  putSecret('ADMIN_PASSWORD', pw);
}

async function stripe() {
  title('Stripe (carte bancaire)');
  console.log('Clés sur https://dashboard.stripe.com → Développeurs → Clés API (sk_test_… ou sk_live_…) et Webhooks (whsec_…).');
  const key = await ask('Clé secrète Stripe (vide = ne pas changer)');
  if (key) putSecret('STRIPE_SECRET_KEY', key);
  const wh = await ask('Secret de signature du webhook (vide = ne pas changer)');
  if (wh) putSecret('STRIPE_WEBHOOK_SECRET', wh);
}

async function appName() {
  const n = await ask('Nom affiché dans l\'application et les emails', getVar(toml, 'APP_NAME'));
  toml = setVar(toml, 'APP_NAME', n);
  varsChanged = true;
}

let again = true;
while (again) {
  console.log(`
Que voulez-vous configurer ? (tout ceci se fait aussi depuis l'application, Plus → Réglages)
  1. PayPal (pour encaisser)
  2. Emails (pour envoyer les clés automatiquement)
  3. Mot de passe administrateur (secours / réinitialisation)
  4. Nom de l'application
  5. Stripe (carte bancaire)
  6. Terminer et mettre en ligne`);
  const c = await ask('Votre choix', '6');
  if (c === '1') await paypal();
  else if (c === '2') await email();
  else if (c === '3') await password();
  else if (c === '4') await appName();
  else if (c === '5') await stripe();
  else again = false;
}

if (varsChanged) {
  writeToml(toml);
  ok('wrangler.toml mis à jour');
  const url = deploy();
  if (url) ok(`Configuration appliquée : ${url}/admin  (écran Réglages pour vérifier)`);
} else {
  ok('Rien à redéployer : les secrets sont appliqués immédiatement.');
}
closePrompt();
