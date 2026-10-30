// Réglages modifiables depuis l'application (stockés dans la base), avec les variables Cloudflare en secours.
// Un réglage saisi dans l'application a priorité sur la variable/secret du même nom.

import { sha256Hex, randomHex } from './crypto.js';

/** Clé de réglage → nom de variable d'environnement équivalente. */
export const SETTING_TO_ENV = {
  app_name: 'APP_NAME',
  currency: 'CURRENCY',
  paypal_env: 'PAYPAL_ENV',
  paypal_client_id: 'PAYPAL_CLIENT_ID',
  paypal_secret: 'PAYPAL_SECRET',
  paypal_webhook_id: 'PAYPAL_WEBHOOK_ID',
  brevo_api_key: 'BREVO_API_KEY',
  resend_api_key: 'RESEND_API_KEY',
  email_from: 'EMAIL_FROM',
  email_from_name: 'EMAIL_FROM_NAME',
  stripe_secret_key: 'STRIPE_SECRET_KEY',
  stripe_webhook_secret: 'STRIPE_WEBHOOK_SECRET',
  signing_secret: 'SIGNING_SECRET',
  admin_password_hash: 'ADMIN_PASSWORD_HASH',
};

/** Réglages sans équivalent env (informations du vendeur, estimation des frais...). */
export const PLAIN_SETTINGS = [
  'seller_name', 'seller_address', 'seller_siret', 'seller_email', 'seller_phone', 'seller_vat_note',
  'paypal_fee_pct', 'paypal_fee_fixed', 'stripe_fee_pct', 'stripe_fee_fixed',
  'manual_methods',   // JSON : moyens de paiement manuels activés et leurs consignes
  'notify_orders',    // '1' = prévenir le vendeur par email à chaque commande à valider
];

/** Réglages qui ne doivent jamais être renvoyés en clair à l'application. */
export const SECRET_SETTINGS = ['paypal_secret', 'paypal_webhook_id', 'brevo_api_key', 'resend_api_key', 'stripe_secret_key', 'stripe_webhook_secret', 'signing_secret', 'admin_password_hash'];

export const ALL_SETTINGS = [...Object.keys(SETTING_TO_ENV), ...PLAIN_SETTINGS];

/** Charge tous les réglages de la base : { key: value }. */
export async function loadSettings(env) {
  const out = {};
  try {
    const r = await env.DB.prepare('SELECT key, value FROM settings').all();
    for (const row of r.results || []) out[row.key] = row.value;
  } catch (e) {
    // table absente (base non initialisée) : on continue avec les variables d'environnement
  }
  return out;
}

/**
 * Fusionne env + réglages : retourne un nouvel objet "env" où chaque réglage non vide
 * remplace la variable correspondante. Les réglages bruts sont accessibles via env.settings.
 */
export async function withSettings(env) {
  const settings = await loadSettings(env);
  const merged = { ...env, settings };
  for (const [key, envName] of Object.entries(SETTING_TO_ENV)) {
    if (settings[key]) merged[envName] = settings[key];
  }
  // Clé de signature : si absente partout, on en génère une et on la garde en base
  if (!merged.SIGNING_SECRET && env.DB) {
    try {
      const secret = randomHex(32);
      await env.DB.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('signing_secret', ?)").bind(secret).run();
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key='signing_secret'").first();
      merged.SIGNING_SECRET = row ? row.value : secret;
      merged.settings.signing_secret = merged.SIGNING_SECRET;
    } catch { /* base non initialisée */ }
  }
  return merged;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).bind(key, String(value ?? '')).run();
}

export async function deleteSetting(env, key) {
  await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
}

/** Hachage du mot de passe administrateur (sel fixe par serveur). */
export async function hashPassword(password, salt) {
  return 'v1$' + (await sha256Hex(`${salt}::${password}`));
}
