// Fonctions communes aux scripts d'installation (setup.mjs, secrets.mjs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOML = path.join(ROOT, 'wrangler.toml');

let rl = null;
function getRl() { if (!rl) rl = readline.createInterface({ input: stdin, output: stdout }); return rl; }
export async function ask(question, def) {
  const a = (await getRl().question(question + (def !== undefined && def !== '' ? ` [${def}] ` : ' '))).trim();
  return a || (def === undefined ? '' : def);
}
export async function askYesNo(question, def = true) {
  const a = (await ask(question + (def ? ' (O/n)' : ' (o/N)'))).toLowerCase();
  if (!a) return def;
  return a.startsWith('o') || a.startsWith('y');
}
export function closePrompt() { if (rl) { rl.close(); rl = null; } }

export function title(t) { console.log(`\n\x1b[1m\x1b[36m${t}\x1b[0m`); }
export function ok(t) { console.log(`\x1b[32m✓\x1b[0m ${t}`); }
export function warn(t) { console.log(`\x1b[33m!\x1b[0m ${t}`); }
export function fail(t) { console.error(`\x1b[31m✗ ${t}\x1b[0m`); }

/** Lance une commande wrangler. Retourne { status, out }. Affiche la sortie si show = true. */
export function wrangler(args, { input, show = false, interactive = false } = {}) {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: interactive ? process.env.CI : (process.env.CI || 'true') };
  if (interactive) delete env.CI;
  const r = spawnSync(cmd, ['wrangler', ...args], {
    cwd: ROOT, env, shell: process.platform === 'win32', encoding: 'utf8',
    input, stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (show && out) console.log(out.trim());
  return { status: r.status, out };
}

export function readToml() { return fs.readFileSync(TOML, 'utf8'); }
export function writeToml(s) { fs.writeFileSync(TOML, s); }

/** Modifie (ou ajoute) une variable de la section [vars] du wrangler.toml. */
export function setVar(toml, key, value) {
  const line = `${key} = ${JSON.stringify(String(value))}`;
  const re = new RegExp(`^${key}\\s*=\\s*"[^"\\n]*"(\\s*#.*)?$`, 'm');
  if (re.test(toml)) return toml.replace(re, (m, comment) => line + (comment || ''));
  return toml.replace(/\[vars\]\n/, `[vars]\n${line}\n`);
}
export function getVar(toml, key) {
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"\\n]*)"`, 'm'));
  return m ? m[1] : '';
}
export function setTop(toml, key, value) {
  const re = new RegExp(`^${key}\\s*=\\s*"[^"\\n]*"`, 'm');
  return toml.replace(re, `${key} = ${JSON.stringify(String(value))}`);
}
export function getTop(toml, key) {
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"\\n]*)"`, 'm'));
  return m ? m[1] : '';
}

/** Définit un secret du Worker. */
export function putSecret(name, value) {
  const r = wrangler(['secret', 'put', name], { input: value + '\n' });
  if (r.status !== 0) { fail(`Impossible d'enregistrer le secret ${name} :\n${r.out}`); return false; }
  ok(`Secret ${name} enregistré`);
  return true;
}

export function ensureLoggedIn() {
  const who = wrangler(['whoami']);
  if (/not authenticated|not logged in|Please run `wrangler login`/i.test(who.out) || who.status !== 0) {
    title('Connexion à Cloudflare');
    console.log('Une page web va s\'ouvrir : connectez-vous à votre compte Cloudflare (gratuit) et autorisez Wrangler.');
    const r = wrangler(['login'], { interactive: true });
    if (r.status !== 0) { fail('La connexion à Cloudflare a échoué.'); process.exit(1); }
  }
  const who2 = wrangler(['whoami']);
  const email = (who2.out.match(/associated with the email '?([^\s']+@[^\s']+)'?/i) || [])[1];
  ok(`Connecté à Cloudflare${email ? ` (${email})` : ''}`);
}

export function ensureDeps() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'wrangler'))) {
    title('Installation des outils (une seule fois)');
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(cmd, ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) { fail('npm install a échoué. Vérifiez que Node.js est installé (https://nodejs.org).'); process.exit(1); }
  }
}

/** Déploie et retourne l'URL publique du Worker. */
export function deploy() {
  title('Déploiement sur Cloudflare');
  let r = wrangler(['deploy'], { show: true });
  if (r.status !== 0 && /subdomain|workers\.dev/i.test(r.out)) {
    // Premier déploiement sur un compte neuf : Cloudflare demande de choisir un sous-domaine (ex : prenom.workers.dev)
    warn('Cloudflare a besoin que vous choisissiez un sous-domaine (une seule fois). Répondez aux questions ci-dessous.');
    wrangler(['deploy'], { interactive: true });
    r = wrangler(['deploy'], { show: false });
  }
  if (r.status !== 0) { fail('Le déploiement a échoué.'); return null; }
  const url = (r.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0] || null;
  if (!url) warn('Déployé, mais adresse introuvable dans la sortie : consultez https://dash.cloudflare.com → Workers.');
  return url || 'https://<votre-serveur>.workers.dev';
}
