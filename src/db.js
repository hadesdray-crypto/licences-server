// Accès à la base de données D1 : licences, produits, clients, événements

import { randomKey } from './crypto.js';
import { nowIso, cleanEmail } from './util.js';
import schemaSql from '../schema.sql';

/** Moyens de paiement « manuels » proposés (le vendeur active ceux qu'il veut dans Réglages). */
export const METHOD_CATALOG = [
  { id: 'virement', label: 'Virement bancaire', hint: 'Votre IBAN (et BIC), ex : FR76 1234 5678 9012 3456 7890 123' },
  { id: 'lydia', label: 'Lydia', hint: 'Votre numéro de téléphone Lydia' },
  { id: 'wero', label: 'Wero', hint: 'Votre numéro de téléphone Wero' },
  { id: 'paypalme', label: 'PayPal (entre proches / lien)', hint: 'Ex : paypal.me/votrenom ou votre email PayPal' },
  { id: 'revolut', label: 'Revolut', hint: 'Votre @revtag ou numéro' },
  { id: 'cash', label: 'Espèces / en main propre', hint: 'Ex : paiement à la remise, sur rendez-vous' },
  { id: 'autre', label: 'Autre', hint: 'Toute autre consigne' },
];
export const METHOD_LABELS = { paypal: 'PayPal', stripe: 'Carte bancaire (Stripe)', card: 'Carte bancaire' };
METHOD_CATALOG.forEach((m) => { METHOD_LABELS[m.id] = m.label; });
export function methodLabel(id) { return METHOD_LABELS[id] || (id ? id : 'Non précisé'); }

/** Moyens manuels activés par le vendeur : [{ id, label, instructions }]. */
export function enabledManualMethods(env) {
  let conf = [];
  try { conf = JSON.parse((env.settings && env.settings.manual_methods) || '[]'); } catch { conf = []; }
  return conf.filter((m) => m && m.enabled && METHOD_CATALOG.some((c) => c.id === m.id))
    .map((m) => ({ id: m.id, label: methodLabel(m.id), instructions: String(m.instructions || '') }));
}

let schemaReady = false;
/**
 * Crée les tables si elles n'existent pas (premier démarrage) et ajoute les colonnes manquantes
 * (mise à jour d'une base existante). Exécuté une fois par instance du serveur.
 */
export async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  try {
    const probe = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('settings','orders')").all();
    const names = new Set((probe.results || []).map((r) => r.name));
    const statements = schemaSql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((x) => x.trim()).filter(Boolean);
    if (!names.has('settings') || !names.has('orders')) {
      // 1) tables manquantes (les tables existantes ne sont pas touchées)
      for (const sql of statements.filter((x) => /^CREATE TABLE/i.test(x))) await env.DB.prepare(sql).run();
    }
    // 2) colonnes ajoutées au fil des versions
    const wanted = {
      products: [['version', "TEXT NOT NULL DEFAULT ''"], ['changelog', "TEXT NOT NULL DEFAULT ''"]],
      licenses: [['payment_method', "TEXT NOT NULL DEFAULT ''"], ['stripe_session_id', 'TEXT'], ['stripe_payment_intent', 'TEXT']],
    };
    for (const [table, cols] of Object.entries(wanted)) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      const have = new Set((info.results || []).map((r) => r.name));
      for (const [col, def] of cols) {
        if (!have.has(col)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
      }
    }
    // 3) index (après les colonnes dont ils dépendent)
    for (const sql of statements.filter((x) => /^CREATE (UNIQUE )?INDEX/i.test(x))) {
      try { await env.DB.prepare(sql).run(); } catch (e) { console.error('index', e.message); }
    }
    schemaReady = true;
  } catch (e) {
    console.error('ensureSchema', e);
  }
}

export async function logEvent(env, type, licenseId, detail) {
  try {
    await env.DB.prepare('INSERT INTO events(type, license_id, detail) VALUES(?,?,?)')
      .bind(type, licenseId ?? null, detail ?? '')
      .run();
  } catch (e) {
    console.error('logEvent', e);
  }
}

/** Compte une requête API dans les statistiques du jour (appelé en arrière-plan). */
export async function bumpStats(env) {
  try {
    const day = nowIso().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO stats_daily(day, requests) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1',
    ).bind(day).run();
  } catch (e) {
    console.error('bumpStats', e);
  }
}

/**
 * Limiteur de débit simple : max `limit` appels par heure pour un même "bucket".
 * Retourne true si la limite est dépassée.
 */
export async function rateLimited(env, bucket, limit) {
  const window = nowIso().slice(0, 13);
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket=? AND window=?').bind(bucket, window).first();
  if (row && row.count >= limit) return true;
  await env.DB.prepare(
    'INSERT INTO rate_limits(bucket, window, count) VALUES(?,?,1) ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1',
  ).bind(bucket, window).run();
  // Nettoyage occasionnel des anciennes fenêtres
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE window < ?').bind(nowIso().slice(0, 13)).run().catch(() => {});
  }
  return false;
}

export async function upsertCustomer(env, email, name) {
  email = cleanEmail(email);
  if (!email) return null;
  await env.DB.prepare(
    `INSERT INTO customers(email, name) VALUES(?,?)
     ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE customers.name END`,
  ).bind(email, name || '').run();
  return env.DB.prepare('SELECT * FROM customers WHERE email=?').bind(email).first();
}

export async function getProduct(env, id) {
  return env.DB.prepare('SELECT * FROM products WHERE id=?').bind(id).first();
}

export async function getProductBySlug(env, slug) {
  return env.DB.prepare('SELECT * FROM products WHERE slug=?').bind(slug).first();
}

export async function listOffers(env, productId, onlyActive = false) {
  const sql = `SELECT * FROM offers WHERE product_id=? ${onlyActive ? 'AND active=1' : ''} ORDER BY sort, days, id`;
  const r = await env.DB.prepare(sql).bind(productId).all();
  return r.results || [];
}

const LICENSE_SELECT = `
  SELECT l.*, p.name AS product_name, p.slug AS product_slug, p.download_url AS product_download_url, p.active AS product_active,
         p.version AS product_version, p.changelog AS product_changelog,
         c.email AS customer_email, c.name AS customer_name,
         (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id) AS devices_used
  FROM licenses l
  JOIN products p ON p.id = l.product_id
  LEFT JOIN customers c ON c.id = l.customer_id`;

export async function getLicense(env, id) {
  return env.DB.prepare(`${LICENSE_SELECT} WHERE l.id=?`).bind(id).first();
}

export async function getLicenseByKey(env, key) {
  return env.DB.prepare(`${LICENSE_SELECT} WHERE l.key=?`).bind(key).first();
}

export async function getLicenseByOrder(env, orderId) {
  return env.DB.prepare(`${LICENSE_SELECT} WHERE l.paypal_order_id=?`).bind(orderId).first();
}

export async function getLicenseByStripeSession(env, sessionId) {
  return env.DB.prepare(`${LICENSE_SELECT} WHERE l.stripe_session_id=?`).bind(sessionId).first();
}

export async function getLicenseByPaymentIntent(env, pi) {
  return env.DB.prepare(`${LICENSE_SELECT} WHERE l.stripe_payment_intent=?`).bind(pi).first();
}

export async function listDevices(env, licenseId) {
  const r = await env.DB.prepare('SELECT * FROM devices WHERE license_id=? ORDER BY first_seen').bind(licenseId).all();
  return r.results || [];
}

/** État calculé d'une licence : active | pending | expired | revoked */
export function licenseState(row, now = nowIso()) {
  if (row.status === 'revoked') return 'revoked';
  if (!row.activated_at) return row.source === 'stock' ? 'stock' : 'pending';
  if (row.expires_at && row.expires_at < now) return 'expired';
  return 'active';
}

/** Ajoute les champs calculés utiles à l'interface. */
export function licenseView(row, now = nowIso()) {
  if (!row) return null;
  const state = licenseState(row, now);
  let days_left = null;
  if (row.expires_at) days_left = Math.ceil((new Date(row.expires_at).getTime() - new Date(now).getTime()) / 86400000);
  return { ...row, state, days_left, lifetime: row.duration_days === 0 };
}

/**
 * Crée une licence avec une clé unique.
 * Si paypal_order_id existe déjà (double appel), retourne la licence existante.
 */
export async function createLicense(env, opts) {
  const {
    product, customer_id = null, offer_label = '', duration_days, max_devices,
    price_cents = 0, source = 'manual', paypal_order_id = null, note = '',
    payment_method = '', stripe_session_id = null, stripe_payment_intent = null,
  } = opts;
  for (let attempt = 0; attempt < 6; attempt++) {
    const key = randomKey(product.key_prefix);
    try {
      const row = await env.DB.prepare(
        `INSERT INTO licenses(key, product_id, customer_id, offer_label, duration_days, max_devices, price_cents, source, paypal_order_id, note,
                              payment_method, stripe_session_id, stripe_payment_intent)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      ).bind(key, product.id, customer_id, offer_label, duration_days, max_devices ?? product.max_devices ?? 2,
        price_cents, source, paypal_order_id, note, payment_method || (source === 'paypal' ? 'paypal' : source === 'stripe' ? 'stripe' : ''),
        stripe_session_id, stripe_payment_intent).first();
      if (source !== 'stock') {
        await logEvent(env, source === 'paypal' ? 'sale' : 'license_created', row.id,
          `${product.name} · ${offer_label || duration_days + ' j'}${price_cents ? ' · ' + (price_cents / 100).toFixed(2) + ' €' : ''}`);
      }
      return getLicense(env, row.id);
    } catch (e) {
      const msg = String(e && e.message);
      if (msg.includes('UNIQUE') && msg.includes('licenses.key')) continue; // collision de clé : on réessaie
      if (msg.includes('UNIQUE') && msg.includes('paypal_order_id') && paypal_order_id) {
        return getLicenseByOrder(env, paypal_order_id);
      }
      if (msg.includes('UNIQUE') && /stripe/.test(msg) && stripe_session_id) {
        return getLicenseByStripeSession(env, stripe_session_id);
      }
      throw e;
    }
  }
  throw new Error('Impossible de générer une clé unique');
}
