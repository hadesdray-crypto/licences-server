// API publique utilisée par les applications des clients (activation, vérification)

import { json, err, readJson, nowIso, addDays, normalizeKey, isEmail, cleanEmail } from './util.js';
import { signToken, verifyToken } from './crypto.js';
import { licenseSecret } from './auth.js';
import {
  getLicense, getLicenseByKey, getProductBySlug, listOffers, licenseView, logEvent, rateLimited, enabledManualMethods, methodLabel,
  upsertCustomer, createLicense,
} from './db.js';
import { randomCode, randomHex } from './crypto.js';
import { sendRecoveryEmail, sendOrderInstructionsEmail, sendSellerOrderNotification } from './email.js';
import { paypalConfigured } from './paypal.js';
import { stripeConfigured } from './stripe.js';

const OFFLINE_GRACE_DAYS = 7;   // un appareil peut rester hors ligne 7 jours avant de devoir se reconnecter
const LIFETIME_TOKEN_DAYS = 30; // pour une licence à vie, le jeton est renouvelé tous les 30 jours

export async function handlePublicApi(request, env, ctx, path, url) {
  const m = request.method;

  if (path === '/ping' && m === 'GET') {
    return json({ ok: true, time: nowIso(), name: env.APP_NAME || 'Serveur de licences' });
  }
  if (path.startsWith('/products/') && m === 'GET') return publicProduct(env, path.slice('/products/'.length));
  if ((path === '/activate' || path === '/verify') && m === 'POST') return activate(env, ctx, await readJson(request));
  if (path === '/lookup' && m === 'POST') return lookup(request, env, await readJson(request), url.origin);
  if (path === '/trial' && m === 'POST') return startTrial(request, env, ctx, await readJson(request));
  if (path === '/orders' && m === 'POST') return createOrder(request, env, ctx, await readJson(request), url.origin);
  if (path.startsWith('/orders/') && m === 'GET') return orderStatus(env, path.slice('/orders/'.length), url.searchParams.get('t') || '', url.origin);
  if (path === '/deactivate' && m === 'POST') return deactivate(env, await readJson(request));
  if (path === '/recover' && m === 'POST') return recover(request, env, ctx, await readJson(request));

  err(404, 'Route introuvable');
}

/** Infos publiques d'un produit (pour la page de vente). Pas de lien de téléchargement ici. */
async function publicProduct(env, slug) {
  const product = await getProductBySlug(env, slug);
  if (!product || !product.active) err(404, 'Application introuvable');
  const offers = (await listOffers(env, product.id, true)).map((o) => ({ id: o.id, label: o.label, days: o.days, price_cents: o.price_cents }));
  return json({
    slug: product.slug, name: product.name, description: product.description, max_devices: product.max_devices,
    version: product.version || '', trial_days: product.trial_days || 0,
    ...(product.trial_days > 0 ? { download_url: product.download_url || '' } : {}),   // public seulement si un essai gratuit existe
    offers, currency: env.CURRENCY || 'EUR',
    paypal_ready: paypalConfigured(env), paypal_env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
    stripe_ready: stripeConfigured(env),
    manual_methods: enabledManualMethods(env),
  });
}

/**
 * Activation / vérification d'une licence.
 * Entrée : { key, device_id, device_name?, app? }  ou  { token, device_id? }
 * Sortie : { ok, token, license: {...} }
 */
async function activate(env, ctx, body) {
  let license = null;
  let deviceId = String(body.device_id || '').trim().slice(0, 128);
  const deviceName = String(body.device_name || '').trim().slice(0, 80);

  if (body.key) {
    const key = normalizeKey(body.key);
    if (key.length < 10) err(400, 'Clé invalide', 'INVALID_KEY');
    license = await getLicenseByKey(env, key);
  } else if (body.token) {
    const payload = await verifyToken(body.token, licenseSecret(env), { allowExpired: true });
    if (!payload || !payload.lid) err(401, 'Jeton invalide', 'INVALID_TOKEN');
    license = await getLicense(env, payload.lid);
    if (!deviceId) deviceId = String(payload.dev || '');
  } else {
    err(400, 'Indiquez une clé (key) ou un jeton (token)', 'MISSING_KEY');
  }

  if (!license) err(404, 'Clé inconnue. Vérifiez la saisie.', 'UNKNOWN_KEY');
  if (!deviceId) err(400, "Identifiant d'appareil manquant (device_id)", 'MISSING_DEVICE');
  if (body.app && String(body.app) !== license.product_slug) {
    err(400, `Cette clé est destinée à une autre application (${license.product_name}).`, 'WRONG_APP');
  }

  return json(await checkAndIssue(env, ctx, license, deviceId, deviceName));
}

/** Vérifie l'état, enregistre l'appareil, et délivre un jeton signé. */
export async function checkAndIssue(env, ctx, license, deviceId, deviceName) {
  const now = nowIso();
  if (!license.product_active) err(403, 'Cette application est désactivée par le vendeur.', 'PRODUCT_DISABLED');
  if (license.status === 'revoked') err(403, 'Cette licence a été désactivée.', 'REVOKED');

  // Première activation : le compte à rebours démarre maintenant
  if (!license.activated_at) {
    const expiresAt = license.duration_days > 0 ? addDays(now, license.duration_days) : null;
    await env.DB.prepare('UPDATE licenses SET activated_at=?, expires_at=? WHERE id=? AND activated_at IS NULL')
      .bind(now, expiresAt, license.id).run();
    license = await getLicense(env, license.id);
    await logEvent(env, 'activate', license.id, `${license.product_name} · ${deviceName || deviceId.slice(0, 12)}`);
  }

  if (license.expires_at && license.expires_at < now) {
    if (license.source === 'trial') err(403, 'Votre période d\'essai gratuit est terminée. Achetez une licence pour continuer.', 'TRIAL_EXPIRED');
    err(403, `Licence expirée le ${license.expires_at.slice(0, 10)}. Renouvelez-la auprès du vendeur.`, 'EXPIRED');
  }

  // Appareils
  const existing = await env.DB.prepare('SELECT id FROM devices WHERE license_id=? AND device_id=?').bind(license.id, deviceId).first();
  if (existing) {
    ctx.waitUntil(env.DB.prepare('UPDATE devices SET last_seen=?, device_name=CASE WHEN ?<>\'\' THEN ? ELSE device_name END WHERE id=?')
      .bind(now, deviceName, deviceName, existing.id).run());
  } else {
    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE license_id=?').bind(license.id).first()).n;
    if (count >= license.max_devices) {
      err(403, `Nombre maximal d'appareils atteint (${license.max_devices}). Désactivez la licence sur un autre appareil ou contactez le vendeur.`, 'DEVICE_LIMIT');
    }
    await env.DB.prepare('INSERT INTO devices(license_id, device_id, device_name) VALUES(?,?,?)').bind(license.id, deviceId, deviceName).run();
    if (count > 0) await logEvent(env, 'device_added', license.id, deviceName || deviceId.slice(0, 12));
  }

  // Jeton signé : valable jusqu'à l'expiration, mais au plus 7 jours (30 pour une licence à vie)
  const nowS = Math.floor(Date.now() / 1000);
  let exp = nowS + (license.expires_at ? OFFLINE_GRACE_DAYS : LIFETIME_TOKEN_DAYS) * 86400;
  if (license.expires_at) exp = Math.min(exp, Math.floor(new Date(license.expires_at).getTime() / 1000));
  const token = await signToken({ lid: license.id, dev: deviceId, exp, iat: nowS }, licenseSecret(env));

  const view = licenseView(license, now);
  const devicesUsed = existing ? view.devices_used : view.devices_used + 1;
  return {
    ok: true,
    token,
    token_expires_at: new Date(exp * 1000).toISOString(),
    server_time: now,
    license: {
      key: license.key,
      product: license.product_slug,
      product_name: license.product_name,
      offer: license.offer_label,
      lifetime: view.lifetime,
      activated_at: license.activated_at,
      expires_at: license.expires_at,
      days_left: view.days_left,
      max_devices: license.max_devices,
      devices_used: devicesUsed,
      trial: license.source === 'trial',
      download_url: license.product_download_url || '',
      latest_version: license.product_version || '',
      changelog: license.product_changelog || '',
    },
  };
}

/**
 * Page /go : le client tape sa clé et retrouve son lien de téléchargement et l'état de sa licence.
 * Aucun appareil n'est enregistré ici. Limité à 30 essais/heure par adresse IP (clé = 80 bits aléatoires).
 */
async function lookup(request, env, body, origin) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (await rateLimited(env, `lookup:${ip}`, 30)) err(429, 'Trop de tentatives. Réessayez plus tard.');
  const key = normalizeKey(body.key);
  if (key.length < 10) err(400, 'Clé invalide', 'INVALID_KEY');
  const license = await getLicenseByKey(env, key);
  if (!license) err(404, 'Clé inconnue. Vérifiez la saisie (le code se trouve dans votre email ou votre message).', 'UNKNOWN_KEY');
  const v = licenseView(license);
  return json({
    ok: true,
    key: license.key,
    product_name: license.product_name,
    product_slug: license.product_slug,
    download_url: license.product_download_url || '',
    state: v.state,
    lifetime: v.lifetime,
    duration_days: license.duration_days,
    expires_at: license.expires_at,
    days_left: v.days_left,
    max_devices: license.max_devices,
    devices_used: v.devices_used,
    buy_url: `${origin}/buy/${license.product_slug}`,
  });
}

/**
 * Essai gratuit : l'application appelle cette route au premier lancement ; une licence « trial » de N jours
 * est créée et activée pour cet appareil. Un seul essai par appareil et par application.
 * Entrée : { app, device_id, device_name?, email? }
 */
async function startTrial(request, env, ctx, body) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (await rateLimited(env, `trial:${ip}`, 20)) err(429, 'Trop de demandes. Réessayez plus tard.');
  const product = await getProductBySlug(env, String(body.app || ''));
  if (!product || !product.active) err(404, 'Application introuvable');
  if (!product.trial_days) err(403, 'Cette application ne propose pas d\'essai gratuit.', 'NO_TRIAL');
  const deviceId = String(body.device_id || '').trim().slice(0, 128);
  if (!deviceId) err(400, "Identifiant d'appareil manquant (device_id)", 'MISSING_DEVICE');
  const deviceName = String(body.device_name || '').trim().slice(0, 80);

  const used = await env.DB.prepare(
    "SELECT l.id FROM licenses l JOIN devices d ON d.license_id = l.id WHERE l.product_id=? AND l.source='trial' AND d.device_id=? ORDER BY l.id DESC LIMIT 1",
  ).bind(product.id, deviceId).first();
  if (used) {
    const existing = await getLicense(env, used.id);
    if (existing.status === 'revoked' || (existing.expires_at && existing.expires_at < nowIso())) {
      err(403, 'La période d\'essai a déjà été utilisée sur cet appareil. Achetez une licence pour continuer.', 'TRIAL_USED');
    }
    return json(await checkAndIssue(env, ctx, existing, deviceId, deviceName)); // essai encore en cours : on le renvoie
  }
  let customer = null;
  if (body.email && isEmail(body.email)) customer = await upsertCustomer(env, body.email, body.name);
  const license = await createLicense(env, {
    product, customer_id: customer ? customer.id : null, offer_label: 'Essai gratuit', duration_days: product.trial_days,
    max_devices: 1, price_cents: 0, source: 'trial', payment_method: 'trial', note: deviceName,
  });
  return json(await checkAndIssue(env, ctx, license, deviceId, deviceName));
}

/** Libère un appareil (le client change d'ordinateur). */
async function deactivate(env, body) {
  const key = normalizeKey(body.key);
  const deviceId = String(body.device_id || '').trim();
  if (!key || !deviceId) err(400, 'Clé et identifiant d\'appareil requis');
  const license = await getLicenseByKey(env, key);
  if (!license) err(404, 'Clé inconnue', 'UNKNOWN_KEY');
  const r = await env.DB.prepare('DELETE FROM devices WHERE license_id=? AND device_id=?').bind(license.id, deviceId).run();
  if (r.meta && r.meta.changes) await logEvent(env, 'device_removed', license.id, deviceId.slice(0, 12));
  return json({ ok: true });
}

/** Clé perdue : renvoie toutes les clés liées à un email. Réponse identique que l'email existe ou non. */
async function recover(request, env, ctx, body) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (await rateLimited(env, `recover:${ip}`, 5)) err(429, 'Trop de demandes. Réessayez plus tard.');
  if (!isEmail(body.email)) err(400, 'Adresse email invalide');
  const email = cleanEmail(body.email);
  const customer = await env.DB.prepare('SELECT * FROM customers WHERE email=?').bind(email).first();
  const message = 'Si cette adresse est connue, un email contenant vos clés vient de vous être envoyé.';
  if (!customer) return json({ ok: true, message });
  const rows = (await env.DB.prepare(
    `SELECT l.*, p.name AS product_name, p.download_url AS product_download_url
     FROM licenses l JOIN products p ON p.id=l.product_id WHERE l.customer_id=? ORDER BY l.created_at DESC`,
  ).bind(customer.id).all()).results || [];
  if (rows.length) {
    const licenses = rows.map((r) => licenseView(r));
    ctx.waitUntil(sendRecoveryEmail(env, { to: email, licenses }).then((r) => logEvent(env, r.ok ? 'recover_sent' : 'recover_failed', null, r.ok ? email : `${email} : ${r.error}`)));
  }
  return json({ ok: true, message });
}

/**
 * Commande payée « à la main » (virement, Lydia, Wero, espèces…) : le client s'inscrit, reçoit les consignes,
 * le vendeur valide dans l'application quand l'argent est arrivé, et la clé part automatiquement.
 */
async function createOrder(request, env, ctx, body, origin) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (await rateLimited(env, `order:${ip}`, 10)) err(429, 'Trop de commandes. Réessayez plus tard.');
  const product = await getProductBySlug(env, String(body.slug || ''));
  if (!product || !product.active) err(404, 'Application introuvable');
  const offer = (await listOffers(env, product.id, true)).find((o) => o.id === Number(body.offer_id));
  if (!offer) err(400, 'Offre introuvable ou désactivée');
  const method = enabledManualMethods(env).find((mm) => mm.id === String(body.method || ''));
  if (!method) err(400, 'Ce moyen de paiement n\'est pas proposé');
  if (!isEmail(body.email)) err(400, 'Indiquez une adresse email valide pour recevoir votre clé.');
  const email = cleanEmail(body.email);
  const name = String(body.name || '').trim().slice(0, 120);

  let row = null;
  for (let i = 0; i < 5 && !row; i++) {
    const ref = 'CMD-' + randomCode(6); // 6 caractères sans ambiguïté
    try {
      row = await env.DB.prepare(
        `INSERT INTO orders(ref, token, product_id, offer_id, offer_label, duration_days, amount_cents, method, email, name)
         VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      ).bind(ref, randomHex(16), product.id, offer.id, offer.label, offer.days, offer.price_cents, method.id, email, name).first();
    } catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; }
  }
  if (!row) throw new Error('Impossible de générer une référence');
  await logEvent(env, 'order_created', null, `${row.ref} · ${product.name} · ${offer.label} · ${methodLabel(method.id)} · ${email}`);

  const statusUrl = `${origin}/order/${row.ref}?t=${row.token}`;
  const order = { ...row, instructions: method.instructions };
  ctx.waitUntil((async () => {
    const r = await sendOrderInstructionsEmail(env, { to: email, order, product, statusUrl, methodLabel: method.label });
    await logEvent(env, r.ok ? 'email_sent' : 'email_failed', null, r.ok ? `consignes ${row.ref} à ${email}` : `consignes ${row.ref} à ${email} : ${r.error}`);
    const sellerEmail = (env.settings || {}).seller_email;
    if (sellerEmail && (env.settings || {}).notify_orders !== '0') {
      await sendSellerOrderNotification(env, { to: sellerEmail, order, product, methodLabel: method.label, adminUrl: `${origin}/admin#/commandes` });
    }
  })());

  return json({
    ok: true, ref: row.ref, token: row.token, status: 'pending', amount_cents: row.amount_cents, currency: env.CURRENCY || 'EUR',
    method: method.id, method_label: method.label, instructions: method.instructions,
    product_name: product.name, offer_label: offer.label, status_url: statusUrl,
  });
}

/** Suivi d'une commande par le client (ref + token). Quand elle est payée, la clé apparaît. */
async function orderStatus(env, ref, token, origin) {
  ref = ref.toUpperCase().trim();
  const row = await env.DB.prepare('SELECT o.*, p.name AS product_name, p.slug AS product_slug, p.download_url FROM orders o JOIN products p ON p.id=o.product_id WHERE o.ref=?').bind(ref).first();
  if (!row || !token || row.token !== token) err(404, 'Commande introuvable');
  const method = enabledManualMethods(env).find((mm) => mm.id === row.method);
  const out = {
    ok: true, ref: row.ref, status: row.status, amount_cents: row.amount_cents, currency: env.CURRENCY || 'EUR',
    method: row.method, method_label: methodLabel(row.method), instructions: method ? method.instructions : '',
    product_name: row.product_name, offer_label: row.offer_label, duration_days: row.duration_days, created_at: row.created_at, paid_at: row.paid_at,
    buy_url: `${origin}/buy/${row.product_slug}`,
  };
  if (row.status === 'paid' && row.license_id) {
    const lic = await getLicense(env, row.license_id);
    if (lic) { out.key = lic.key; out.download_url = lic.product_download_url || ''; out.max_devices = lic.max_devices; }
  }
  return json(out);
}
