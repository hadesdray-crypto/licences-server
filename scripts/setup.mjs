#!/usr/bin/env node
// Installation complète du serveur de licences en une commande :  npm run setup
// Options :  --name <nom-du-serveur>   (défaut : licences)   ex : npm run setup -- --name licences-2

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, ask, closePrompt, title, ok, warn, fail, wrangler, readToml, writeToml, setTop, getTop, getVar, setVar,
  putSecret, ensureLoggedIn, ensureDeps, deploy,
} from './common.mjs';

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

console.log('\x1b[1m\n🔑  Installation du serveur de licences\x1b[0m');
console.log('Ce script crée votre serveur gratuit sur Cloudflare, sa base de données, et l\'application d\'administration.\n');

ensureDeps();
ensureLoggedIn();

let toml = readToml();
const currentName = getTop(toml, 'name') || 'licences';
const name = (argVal('--name') || (await ask('Nom du serveur (lettres minuscules, chiffres, tirets)', currentName)))
  .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'licences';
const dbName = argVal('--db') || `${name}-db`;
toml = setTop(toml, 'name', name);
toml = toml.replace(/database_name\s*=\s*"[^"]*"/, `database_name = "${dbName}"`);

const appName = await ask('Nom affiché dans l\'application (ex : Mes licences, Boutique Youpub)', getVar(toml, 'APP_NAME') || 'Mes licences');
toml = setVar(toml, 'APP_NAME', appName);

// ---- Base de données D1 ----
title('Base de données');
let dbId = null;
let r = wrangler(['d1', 'create', dbName]);
if (r.status === 0) {
  dbId = (r.out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i) || r.out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1] || null;
  ok(`Base « ${dbName} » créée`);
} else if (/already exists/i.test(r.out)) {
  warn(`La base « ${dbName} » existe déjà, on la réutilise.`);
} else {
  fail(`Création de la base impossible :\n${r.out}`);
  process.exit(1);
}
if (!dbId) {
  const list = wrangler(['d1', 'list', '--json']);
  try {
    const arr = JSON.parse(list.out.slice(list.out.indexOf('[')));
    const found = arr.find((d) => d.name === dbName);
    if (found) dbId = found.uuid || found.id;
  } catch { /* ignoré */ }
}
if (!dbId) { fail('Identifiant de la base introuvable. Relancez le script.'); process.exit(1); }
if (/database_id\s*=/.test(toml)) toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`);
else toml = toml.replace(/(database_name\s*=\s*"[^"]*"\s*\n)/, `$1database_id = "${dbId}"\n`);
writeToml(toml);
ok('wrangler.toml mis à jour');

r = wrangler(['d1', 'execute', dbName, '--remote', '--file=schema.sql', '--yes']);
if (r.status !== 0) { fail(`Initialisation des tables impossible :\n${r.out}`); process.exit(1); }
ok('Tables créées');

// ---- Déploiement (le Worker doit exister avant les secrets) ----
let url = deploy();
if (!url) process.exit(1);
ok(`Serveur en ligne : ${url}`);

// ---- Secrets ----
title('Sécurité');
if (!putSecret('SIGNING_SECRET', crypto.randomBytes(32).toString('hex'))) process.exit(1);
console.log('Le mot de passe administrateur se choisit dans l\'application, au premier lancement.');

fs.writeFileSync(path.join(ROOT, '.server-info.json'), JSON.stringify({ name, dbName, url, created: new Date().toISOString() }, null, 2));

// ---- Résumé ----
const adminUrl = `${url}/admin`;
title('🎉 Installation terminée');
console.log(`
  Votre serveur      : ${url}
  Votre application  : ${adminUrl}

  ÉTAPE SUIVANTE (maintenant) : la page de l'application s'ouvre dans votre navigateur.
  Choisissez-y votre mot de passe administrateur. C'est tout !

  Sur votre téléphone : ouvrez ${adminUrl} puis « Ajouter à l'écran d'accueil ».
  Tout le reste (PayPal, carte bancaire, virement/Lydia/Wero, emails, ventes…) se fait dans l'application : Plus → Réglages.

  Plus tard, sur l'ordinateur : MISE-A-JOUR (ou npm run deploy) pour installer une nouvelle version du code.
`);
try {
  const opener = process.platform === 'win32' ? `start "" "${adminUrl}"` : process.platform === 'darwin' ? `open "${adminUrl}"` : `xdg-open "${adminUrl}"`;
  (await import('node:child_process')).exec(opener);
} catch { /* le lien est affiché ci-dessus */ }
closePrompt();
