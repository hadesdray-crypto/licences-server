// Paiement PayPal : création de commande, capture, webhook (paiement confirmé / remboursement)

import { json, err, readJson, isEmail, cleanEmail, fmtDuration } from './util.js';
import {
  getProductBySlug, getProduct, listOffers, createLicense, getLicenseByOrder, upsertCustomer, logEvent, licenseView,
} from './db.js';
import { sendLicenseEmail } from './email.js';

export function paypalConfigured(env) {
  return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET);
}

function baseUrl(env) {
  return env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function accessToken(env) {
  if (!paypalConfigured(env)) err(503, 'PayPal n\'est pas configuré (PAYPAL_CLIENT_ID / PAYPAL_SECRET). Voir le guide, étape PayPal.');
  const res = await fetch(`${baseUrl(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`PayPal refuse les identifiants (${res.status}) : ${t.slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

async function api(env, method, path, body) {
  let token, res;
  try {
    token = await accessToken(env);
    res = await fetch(`${baseUrl(env)}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'prefer': 'return=representation' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e && e.status) throw e;
    err(502, 'Impossible de joindre PayPal. Réessayez dans un instant.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  return { status: res.status, ok: res.ok, data };
}

export async function handlePaypal(request, env, ctx, path) {
  const m = request.method;
  if (path === '/create-order' && m === 'POST') return createOrder(env, await readJson(request));
  if (path === '/capture' && m === 'POST') return captureEndpoint(env, ctx, await readJson(request), request);
  if (path === '/webhook' && m === 'POST') return webhook(request, env, ctx);
  err(404, 'Route PayPal introuvable');
}

/** Étape 1 : le client a choisi une offre, on crée la commande côté PayPal (montant fixé par le serveur). */
async function createOrder(env, body) {
  const product = await getProductBySlug(env, String(body.slug || ''));
  if (!product || !product.active) err(404, 'Application introuvable');
  const offer = (await listOffers(env, product.id, true)).find((o) => o.id === Number(body.offer_id));
  if (!offer) err(400, 'Offre introuvable ou désactivée');
  if (offer.price_cents <= 0) err(400, 'Cette offre est gratuite : demandez une clé au vendeur.');
  if (!isEmail(body.email)) err(400, 'Indiquez une adresse email valide pour recevoir votre clé.');
  const email = cleanEmail(body.email);
  const currency = env.CURRENCY || 'EUR';

  const r = await api(env, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: `${product.id}-${offer.id}`,
      custom_id: `${product.id}:${offer.id}`,
      description: `${product.name} – ${offer.label}`.slice(0, 127),
      amount: { currency_code: currency, value: (offer.price_cents / 100).toFixed(2) },
    }],
    application_context: {
      brand_name: (env.APP_NAME || product.name).slice(0, 127),
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
    },
  });
  if (!r.ok || !r.data || !r.data.id) {
    await logEvent(env, 'paypal_error', null, `create-order ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    err(502, 'PayPal n\'a pas pu créer la commande. Réessayez dans un instant.');
  }
  await env.DB.prepare('INSERT OR REPLACE INTO paypal_orders(order_id, product_id, offer_id, email, status) VALUES(?,?,?,?,?)')
    .bind(r.data.id, product.id, offer.id, email, 'created').run();
  return json({ order_id: r.data.id });
}

/** Étape 2 : le client a approuvé le paiement, on capture et on crée la licence. */
async function captureEndpoint(env, ctx, body, request) {
  const orderId = String(body.order_id || '').trim();
  if (!orderId) err(400, 'order_id manquant');
  const result = await captureAndFulfill(env, ctx, orderId, new URL(request.url).origin);
  return json(result);
}

/**
 * Capture la commande (idempotent) puis crée la licence et envoie l'email.
 * Utilisé par la page de vente ET par le webhook (sécurité si le client ferme la page trop tôt).
 */
export async function captureAndFulfill(env, ctx, orderId, origin) {
  const already = await getLicenseByOrder(env, orderId);
  if (already) return fulfillmentResponse(env, already);

  let r = await api(env, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});
  if (r.status === 422 && JSON.stringify(r.data || {}).includes('ORDER_ALREADY_CAPTURED')) {
    r = await api(env, 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }
  if (!r.ok || !r.data) {
    await logEvent(env, 'paypal_error', null, `capture ${orderId} ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    err(502, 'PayPal n\'a pas confirmé le paiement. Si vous avez été débité, contactez le vendeur avec votre email.');
  }
  const order = r.data;
  if (order.status !== 'COMPLETED') {
    err(402, `Paiement non finalisé (état PayPal : ${order.status}).`);
  }
  const unit = (order.purchase_units || [])[0] || {};
  const capture = ((unit.payments || {}).captures || [])[0] || {};
  const amountCents = Math.round(parseFloat((capture.amount || unit.amount || {}).value || '0') * 100);
  const payerEmail = (order.payer || {}).email_address || '';
  const payerName = [((order.payer || {}).name || {}).given_name, ((order.payer || {}).name || {}).surname].filter(Boolean).join(' ');

  return fulfillOrder(env, ctx, { orderId, customId: unit.custom_id, amountCents, payerEmail, payerName, origin });
}

/** Crée la licence liée à une commande payée (idempotent) et envoie l'email. */
async function fulfillOrder(env, ctx, { orderId, customId, amountCents, payerEmail, payerName, origin }) {
  const existing = await getLicenseByOrder(env, orderId);
  if (existing) return fulfillmentResponse(env, existing);

  const stored = await env.DB.prepare('SELECT * FROM paypal_orders WHERE order_id=?').bind(orderId).first();
  let productId = stored ? stored.product_id : null;
  let offerId = stored ? stored.offer_id : null;
  if ((!productId || !offerId) && customId && /^\d+:\d+$/.test(customId)) {
    [productId, offerId] = customId.split(':').map(Number);
  }
  const product = productId ? await getProduct(env, productId) : null;
  if (!product) {
    await logEvent(env, 'paypal_error', null, `commande ${orderId} : produit introuvable (${customId})`);
    err(500, 'Commande payée mais produit introuvable : contactez le vendeur.');
  }
  const offer = offerId ? await env.DB.prepare('SELECT * FROM offers WHERE id=?').bind(offerId).first() : null;
  const email = (stored && stored.email) || cleanEmail(payerEmail);
  const customer = email ? await upsertCustomer(env, email, payerName) : null;

  const license = await createLicense(env, {
    product,
    customer_id: customer ? customer.id : null,
    offer_label: offer ? offer.label : '',
    duration_days: offer ? offer.days : 365,
    max_devices: product.max_devices,
    price_cents: amountCents || (offer ? offer.price_cents : 0),
    source: 'paypal',
    paypal_order_id: orderId,
    note: payerEmail && payerEmail !== email ? `Email PayPal : ${payerEmail}` : '',
  });
  await env.DB.prepare('UPDATE paypal_orders SET status=? WHERE order_id=?').bind('completed', orderId).run().catch(() => {});

  if (email) {
    const buyUrl = origin ? `${origin}/buy/${product.slug}` : '';
    ctx.waitUntil(sendLicenseEmail(env, { to: email, license, product, buyUrl }));
  }
  return fulfillmentResponse(env, license, true);
}

function fulfillmentResponse(env, license, emailQueued = false) {
  const v = licenseView(license);
  return {
    ok: true,
    key: license.key,
    product: { name: license.product_name, slug: license.product_slug, download_url: license.product_download_url || '' },
    offer_label: license.offer_label,
    duration_days: license.duration_days,
    duration_text: fmtDuration(license.duration_days),
    max_devices: license.max_devices,
    email: license.customer_email || '',
    email_queued: emailQueued && !!license.customer_email,
    state: v.state,
  };
}

/** Webhook PayPal : vérifie la signature puis traite l'événement. */
async function webhook(request, env, ctx) {
  const raw = await request.text();
  let event;
  try { event = JSON.parse(raw); } catch { err(400, 'JSON invalide'); }

  if (!env.PAYPAL_WEBHOOK_ID) {
    await logEvent(env, 'webhook_ignored', null, 'PAYPAL_WEBHOOK_ID non configuré');
    err(503, 'Webhook non configuré (PAYPAL_WEBHOOK_ID)');
  }
  const h = (n) => request.headers.get(n) || '';
  const verif = await api(env, 'POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  if (!verif.ok || !verif.data || verif.data.verification_status !== 'SUCCESS') {
    await logEvent(env, 'webhook_rejected', null, `${event.event_type || '?'} signature invalide`);
    err(400, 'Signature du webhook invalide');
  }

  const type = event.event_type;
  const res = event.resource || {};
  const origin = new URL(request.url).origin;
  try {
    if (type === 'CHECKOUT.ORDER.APPROVED' && res.id) {
      await captureAndFulfill(env, ctx, res.id, origin);
    } else if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = (((res.supplementary_data || {}).related_ids || {}).order_id) || null;
      if (orderId) {
        await fulfillOrder(env, ctx, {
          orderId, customId: res.custom_id,
          amountCents: Math.round(parseFloat((res.amount || {}).value || '0') * 100),
          payerEmail: '', payerName: '', origin,
        });
      }
    } else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
      const orderId = (((res.supplementary_data || {}).related_ids || {}).order_id) || null;
      const lic = orderId ? await getLicenseByOrder(env, orderId) : null;
      if (lic) {
        await env.DB.prepare('UPDATE licenses SET status=? WHERE id=?').bind('revoked', lic.id).run();
        await logEvent(env, 'refund', lic.id, `${type} · licence désactivée automatiquement`);
      }
    }
  } catch (e) {
    // On journalise mais on répond 200 pour que PayPal ne renvoie pas l'événement en boucle si l'erreur est définitive
    await logEvent(env, 'webhook_error', null, `${type} : ${String(e.message || e).slice(0, 200)}`);
  }
  return json({ received: true });
}

/** Diagnostic de la configuration PayPal (écran Réglages). */
export async function paypalHealth(env, test = false) {
  const out = {
    env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
    client_id_set: !!env.PAYPAL_CLIENT_ID,
    secret_set: !!env.PAYPAL_SECRET,
    webhook_id_set: !!env.PAYPAL_WEBHOOK_ID,
    configured: paypalConfigured(env),
  };
  if (test && out.configured) {
    try { await accessToken(env); out.test = { ok: true }; } catch (e) { const m = String(e.message || e); out.test = { ok: false, error: /fetch failed|network/i.test(m) ? 'Impossible de joindre PayPal depuis le serveur (réseau). Réessayez.' : m }; }
  }
  return out;
}
