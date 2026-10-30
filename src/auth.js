// Authentification de l'administrateur (mot de passe -> jeton de session 30 jours)

import { json, err, readJson } from './util.js';
import { signToken, verifyToken, timingSafeEqual } from './crypto.js';
import { rateLimited } from './db.js';
import { hashPassword, setSetting } from './settings.js';

const SESSION_DAYS = 30;
const PASSWORD_SALT = 'licences-admin-v1';

/** Secret servant à signer les sessions admin (change si un des mots de passe change). */
function adminSecret(env) {
  return `${env.SIGNING_SECRET || ''}:admin:${env.ADMIN_PASSWORD_HASH || ''}:${env.ADMIN_PASSWORD || ''}`;
}

/** Secret servant à signer les jetons de licence remis aux applications. */
export function licenseSecret(env) {
  return `${env.SIGNING_SECRET || env.ADMIN_PASSWORD || 'non-configure'}:licence`;
}

export function passwordConfigured(env) {
  return !!(env.ADMIN_PASSWORD_HASH || env.ADMIN_PASSWORD);
}

/**
 * Vérifie un mot de passe : celui défini dans l'application (haché en base), ou le secret Cloudflare ADMIN_PASSWORD
 * (qui sert aussi de mot de passe de secours si vous perdez celui de l'application).
 */
export async function checkPassword(env, password) {
  password = String(password || '');
  if (!password) return false;
  let ok = false;
  if (env.ADMIN_PASSWORD_HASH) ok = timingSafeEqual(await hashPassword(password, PASSWORD_SALT), env.ADMIN_PASSWORD_HASH);
  if (!ok && env.ADMIN_PASSWORD) ok = timingSafeEqual(password, env.ADMIN_PASSWORD);
  return ok;
}

/** Premier lancement : aucun mot de passe n'existe encore, l'administrateur en choisit un. */
export async function firstRunSetup(request, env) {
  if (passwordConfigured(env)) err(409, 'Un mot de passe existe déjà. Connectez-vous.');
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (await rateLimited(env, `setup:${ip}`, 5)) err(429, 'Trop de tentatives. Réessayez dans une heure.');
  const body = await readJson(request);
  const pw = String(body.password || '');
  if (pw.length < 8) err(400, 'Le mot de passe doit faire au moins 8 caractères');
  const hash = await hashPassword(pw, PASSWORD_SALT);
  await setSetting(env, 'admin_password_hash', hash);
  const newEnv = { ...env, ADMIN_PASSWORD_HASH: hash };
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const token = await signToken({ role: 'admin', exp, iat: Math.floor(Date.now() / 1000) }, adminSecret(newEnv));
  return json({ ok: true, token, expires_at: new Date(exp * 1000).toISOString() });
}

export async function login(request, env) {
  if (!passwordConfigured(env)) err(409, 'Aucun mot de passe défini : créez-le (premier lancement).', 'NEEDS_SETUP');
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (await rateLimited(env, `login:${ip}`, 10)) err(429, 'Trop de tentatives. Réessayez dans une heure.');

  const { password } = await readJson(request);
  if (!(await checkPassword(env, password))) err(401, 'Mot de passe incorrect');

  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const token = await signToken({ role: 'admin', exp, iat: Math.floor(Date.now() / 1000) }, adminSecret(env));
  return json({ token, expires_at: new Date(exp * 1000).toISOString() });
}

export async function requireAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const payload = token ? await verifyToken(token, adminSecret(env)) : null;
  if (!payload || payload.role !== 'admin') err(401, 'Non autorisé : connectez-vous');
  return payload;
}

/** Changement de mot de passe depuis l'application : { current, new } */
export async function changePassword(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (await rateLimited(env, `login:${ip}`, 10)) err(429, 'Trop de tentatives. Réessayez dans une heure.');
  const body = await readJson(request);
  if (!(await checkPassword(env, body.current))) err(401, 'Mot de passe actuel incorrect');
  const next = String(body.new || '');
  if (next.length < 8) err(400, 'Le nouveau mot de passe doit faire au moins 8 caractères');
  const hash = await hashPassword(next, PASSWORD_SALT);
  await setSetting(env, 'admin_password_hash', hash);
  // Nouvelle session immédiatement utilisable (l'ancienne devient invalide)
  const newEnv = { ...env, ADMIN_PASSWORD_HASH: hash };
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const token = await signToken({ role: 'admin', exp, iat: Math.floor(Date.now() / 1000) }, adminSecret(newEnv));
  return json({ ok: true, token, expires_at: new Date(exp * 1000).toISOString() });
}

function linkSecret(env) { return `${env.SIGNING_SECRET || env.ADMIN_PASSWORD || 'non-configure'}:link`; }

/** Lien signé et temporaire (ex : reçu consultable sans mot de passe). */
export async function signLink(env, purpose, id, hours = 24 * 30) {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  return signToken({ p: purpose, id, exp }, linkSecret(env)); // le jeton contient déjà id et exp
}

export async function verifyLink(env, purpose, id, token) {
  const payload = await verifyToken(token, linkSecret(env));
  return !!(payload && payload.p === purpose && String(payload.id) === String(id));
}
