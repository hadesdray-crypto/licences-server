// Signature HMAC (jetons), génération de clés, comparaison sécurisée

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Crée un jeton signé : base64url(payload) + "." + base64url(signature). */
export async function signToken(payload, secret) {
  const key = await hmacKey(secret);
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return body + '.' + b64url(sig);
}

/**
 * Vérifie un jeton. Retourne le payload si la signature est valide, sinon null.
 * Par défaut, un jeton expiré est refusé (sauf allowExpired = true).
 */
export async function verifyToken(token, secret, { allowExpired = false } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(body)));
    if (!allowExpired && payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Alphabet sans caractères ambigus (pas de 0/O, 1/I). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Génère une clé du type PREFIX-XXXX-XXXX-XXXX-XXXX. */
export function randomKey(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += ALPHABET[bytes[i] % ALPHABET.length];
    if (i % 4 === 3 && i < 15) s += '-';
  }
  return `${prefix}-${s}`;
}

/** Code court sans caractères ambigus (ex : référence de commande). */
export function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export function randomHex(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparaison à temps constant (évite de deviner un mot de passe caractère par caractère). */
export function timingSafeEqual(a, b) {
  const ba = enc.encode(String(a));
  const bb = enc.encode(String(b));
  let diff = ba.length ^ bb.length;
  const n = Math.max(ba.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ba[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}
