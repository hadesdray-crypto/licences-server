#!/usr/bin/env node
// Serveur de test 100 % local, SANS compte Cloudflare :  npm run local
// Il exécute exactement le même code que sur Cloudflare, avec une base SQLite locale (.local-db.sqlite).
// Pratique pour essayer l'application d'administration avant la mise en ligne.
// (Nécessite Node.js 22.5 ou plus récent.)

import { register } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
register('./asset-loader.mjs', import.meta.url);

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 8787;
const MEMORY = args.includes('--memory');
const QUIET = args.includes('--quiet');
const NO_PASSWORD = args.includes('--no-password');   // tests : premier lancement (mot de passe choisi dans l'application)
const OLD_SCHEMA = args.includes('--old-schema');     // tests : base d'une ancienne version, migrée automatiquement par le serveur

// ----- Base de données : émulation de l'API D1 au-dessus de node:sqlite -----
const dbPath = MEMORY ? ':memory:' : path.join(ROOT, '.local-db.sqlite');
const sqlite = new DatabaseSync(dbPath);
sqlite.exec('PRAGMA foreign_keys = ON');
let schemaText = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
if (OLD_SCHEMA) {
  // Simule une base créée par la toute première version : sans tables settings/orders ni colonnes récentes
  schemaText = schemaText.replace(/CREATE TABLE IF NOT EXISTS settings[\s\S]*?\);/, '').replace(/CREATE TABLE IF NOT EXISTS orders[\s\S]*?\);/, '')
    .replace(/CREATE INDEX IF NOT EXISTS idx_orders_status[^;]*;/, '').replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_stripe[^;]*;/, '')
    .replace(/^\s*(version|changelog|payment_method|stripe_session_id|stripe_payment_intent)\s.*$/gm, '');
}
sqlite.exec(schemaText);

function d1Error(e) { const err = new Error('D1_ERROR: ' + e.message); err.cause = e; return err; }
const DB = {
  prepare(sql) {
    let params = [];
    const stmt = () => sqlite.prepare(sql);
    const api = {
      bind(...p) { params = p.map((v) => (v === undefined ? null : v)); return api; },
      async first(col) { try { const row = stmt().get(...params) ?? null; return col && row ? row[col] : row; } catch (e) { throw d1Error(e); } },
      async all() { try { return { results: stmt().all(...params), success: true }; } catch (e) { throw d1Error(e); } },
      async run() { try { const r = stmt().run(...params); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; } catch (e) { throw d1Error(e); } },
    };
    return api;
  },
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  async exec(sql) { sqlite.exec(sql); return { count: 1 }; },
};

// ----- Variables : [vars] du wrangler.toml + secrets du fichier .dev.vars -----
function readVars() {
  const env = { DB };
  const toml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  const varsBlock = (toml.split(/^\[vars\]\s*$/m)[1] || '').split(/^\[/m)[0];
  for (const m of varsBlock.matchAll(/^([A-Z_]+)\s*=\s*"([^"]*)"/gm)) env[m[1]] = m[2];
  const devVars = path.join(ROOT, '.dev.vars');
  if (fs.existsSync(devVars)) {
    for (const line of fs.readFileSync(devVars, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  if (NO_PASSWORD) delete env.ADMIN_PASSWORD;
  else if (!env.ADMIN_PASSWORD) { env.ADMIN_PASSWORD = 'test1234'; console.log('ℹ️  Aucun mot de passe dans .dev.vars : mot de passe de test = test1234'); }
  return env;
}
const env = readVars();

// ----- Serveur HTTP → worker.fetch(request, env, ctx) -----
const worker = (await import(pathToFileURL(path.join(ROOT, 'src/index.js')).href)).default;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : null;
  const url = `http://${req.headers.host || 'localhost:' + PORT}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');
  const request = new Request(url, { method: req.method, headers, body: body && !['GET', 'HEAD'].includes(req.method) ? body : undefined });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch((e) => console.error('waitUntil', e))), passThroughOnException() {} };
  try {
    const response = await worker.fetch(request, env, ctx);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
    if (!QUIET) console.log(`${req.method} ${req.url} → ${response.status}`);
  } catch (e) {
    console.error(e);
    res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) }));
  }
  await Promise.all(pending);
});

server.listen(PORT, () => {
  console.log(`\n🔑  Serveur de licences LOCAL en marche`);
  console.log(`   Administration : http://localhost:${PORT}/admin`);
  console.log(`   Base de données : ${MEMORY ? 'en mémoire (perdue à l\'arrêt)' : dbPath}`);
  console.log(`   Arrêt : Ctrl + C\n`);
});
