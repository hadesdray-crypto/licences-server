// Fonctions utilitaires partagées

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
  'access-control-max-age': '86400',
};

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

/** Lève une erreur HTTP avec un message en français. */
export function err(status, message, code) {
  throw new HttpError(status, message, code);
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...headers },
  });
}

export const nowIso = () => new Date().toISOString();

export function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86400000).toISOString();
}

export async function readJson(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== 'object') err(400, 'Corps de requête JSON invalide');
    return data;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    err(400, 'Corps de requête JSON invalide');
  }
}

export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

export function cleanEmail(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Normalise une clé saisie par un client : majuscules, et remet les tirets au bon endroit
 * quelle que soit la saisie ("youpub 49yy kjtk yq4w 4bgv", "YOUPUB49YYKJTKYQ4W4BGV"…).
 */
export function normalizeKey(s) {
  const flat = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (flat.length <= 16) return flat;
  const prefix = flat.slice(0, -16);
  const body = flat.slice(-16);
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
}

export function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Formate des centimes en euros à la française (1999 -> "19,99 €"). */
export function fmtCents(cents, currency = 'EUR') {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format((cents || 0) / 100);
  } catch {
    return (cents / 100).toFixed(2) + ' ' + currency;
  }
}

export function fmtDuration(days) {
  if (!days || days <= 0) return 'à vie';
  if (days % 365 === 0) return days / 365 === 1 ? '1 an' : `${days / 365} ans`;
  if (days % 30 === 0) return `${days / 30} mois`;
  if (days % 7 === 0) return days / 7 === 1 ? '1 semaine' : `${days / 7} semaines`;
  return days === 1 ? '1 jour' : `${days} jours`;
}

export function fmtDateFr(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(new Date(iso));
  } catch {
    return iso;
  }
}
