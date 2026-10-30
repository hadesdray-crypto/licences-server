// Paiement par carte bancaire via Stripe Checkout (Apple Pay / Google Pay inclus) + webhook (paiement, remboursement)

import { json, err, readJson, isEmail, cleanEmail, fmtDuration } from './util.js';
import {
  getProductBySlug, getProduct, listOffers, createLicense, getLicenseByStripeSession, getLicenseByPaymentIntent,
  upsertCustomer, logEvent, licenseView,
} from './db.js';
import { sendLicenseEmail } from './email.js';

export function stripeConfigured(env) {
  return !!env.STRIPE_SECRET_KEY;
}

/** Appel à l'API Stripe (corps au format formulaire). */
async function stripeApi(env, method, path, params) {
  if (!stripeConfigured(env)) err(503, 'Stripe n\'est pas configuré (clé secrète). Réglages → Stripe.');
  const body = params ? encodeForm(params) : undefined;
  let res;
  try {
    res = await fetch(`https://api.stripe.com${path}`, {
      method,
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20' },
      body,
    });
  } catch (e) {
    err(502, 'Impossible de joindre Stripe. Réessayez dans un instant.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* vide */ }
  return { status: res.status, ok: res.ok, data };
}

/** Transforme { a: { b: 1 }, c: [x] } en a[b]=1&c[0]=x */
function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? encodeForm(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

export async function handleStripe(request, env, ctx, path) {
  const m = request.method;
  const origin = new URL(request.url).origin;
  if (path === '/create-session' && m === 'POST') return createSession(env, await readJson(request), origin);
  if (path === '/confirm' && m === 'POST') return confirmEndpoint(env, ctx, await readJson(request), origin);
  if (path === '/webhook' && m === 'POST') return webhook(request, env, ctx);
  err(404, 'Route Stripe introuvable');
}

/** Étape 1 : crée une session Checkout (prix fixé côté serveur) et renvoie l'URL de paiement Stripe. */
async function createSession(env, body, origin) {
  const product = await getProductBySlug(env, String(body.slug || ''));
  if (!product || !product.active) err(404, 'Application introuvable');
  const offer = (await listOffers(env, product.id, true)).find((o) => o.id === Number(body.offer_id));
  if (!offer) err(400, 'Offre introuvable ou désactivée');
  if (offer.price_cents <= 0) err(400, 'Cette offre est gratuite : demandez une clé au vendeur.');
  if (!isEmail(body.email)) err(400, 'Indiquez une adresse email valide pour recevoir votre clé.');
  const email = cleanEmail(body.email);
  const currency = (env.CURRENCY || 'EUR').toLowerCase();

  const r = await stripeApi(env, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    locale: 'fr',
    customer_email: email,
    success_url: `${origin}/buy/${product.slug}?stripe_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/buy/${product.slug}?cancelled=1`,
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: offer.price_cents,
        product_data: { name: `${product.name} – ${offer.label}`.slice(0, 250), description: `Licence ${fmtDuration(offer.days)} · ${product.max_devices} appareil(s)`.slice(0, 250) },
      },
    }],
    metadata: { product_id: String(product.id), offer_id: String(offer.id), email },
    payment_intent_data: { description: `${product.name} – ${offer.label}`.slice(0, 250), metadata: { product_id: String(product.id), offer_id: String(offer.id) } },
  });
  if (!r.ok || !r.data || !r.data.url) {
    await logEvent(env, 'stripe_error', null, `create-session ${r.status} ${JSON.stringify((r.data || {}).error || r.data).slice(0, 300)}`);
    err(502, 'Stripe n\'a pas pu créer le paiement. Réessayez dans un instant.');
  }
  return json({ session_id: r.data.id, url: r.data.url });
}

/** Étape 2 : retour sur la page de vente avec ?stripe_session=... → on vérifie le paiement et on crée la licence. */
async function confirmEndpoint(env, ctx, body, origin) {
  const sessionId = String(body.session_id || '').trim();
  if (!/^cs_/.test(sessionId)) err(400, 'Identifiant de session invalide');
  const existing = await getLicenseByStripeSession(env, sessionId);
  if (existing) return json(fulfillmentResponse(existing));
  const r = await stripeApi(env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!r.ok || !r.data) err(502, 'Stripe n\'a pas confirmé le paiement. Si vous avez été débité, contactez le vendeur avec votre email.');
  if (r.data.payment_status !== 'paid') err(402, `Paiement non finalisé (état : ${r.data.payment_status || r.data.status}).`);
  const lic = await fulfillSession(env, ctx, r.data, origin);
  return json(fulfillmentResponse(lic, true));
}

/** Crée la licence pour une session Checkout payée (idempotent) et envoie l'email. */
async function fulfillSession(env, ctx, session, origin) {
  const existing = await getLicenseByStripeSession(env, session.id);
  if (existing) return existing;
  const meta = session.metadata || {};
  const product = meta.product_id ? await getProduct(env, Number(meta.product_id)) : null;
  if (!product) {
    await logEvent(env, 'stripe_error', null, `session ${session.id} : produit introuvable`);
    err(500, 'Paiement reçu mais produit introuvable : contactez le vendeur.');
  }
  const offer = meta.offer_id ? await env.DB.prepare('SELECT * FROM offers WHERE id=?').bind(Number(meta.offer_id)).first() : null;
  const email = cleanEmail(((session.customer_details || {}).email) || session.customer_email || meta.email || '');
  const name = (session.customer_details || {}).name || '';
  const customer = email ? await upsertCustomer(env, email, name) : null;
  const license = await createLicense(env, {
    product,
    customer_id: customer ? customer.id : null,
    offer_label: offer ? offer.label : '',
    duration_days: offer ? offer.days : 365,
    max_devices: product.max_devices,
    price_cents: session.amount_total || (offer ? offer.price_cents : 0),
    source: 'stripe',
    payment_method: 'stripe',
    stripe_session_id: session.id,
    stripe_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent || {}).id || null,
  });
  if (email) ctx.waitUntil(sendLicenseEmail(env, { to: email, license, product, buyUrl: `${origin}/buy/${product.slug}` }));
  return license;
}

function fulfillmentResponse(license, emailQueued = false) {
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

/** Vérifie la signature Stripe-Signature (HMAC-SHA256, tolérance 5 minutes). */
async function verifySignature(rawBody, header, secret) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

async function webhook(request, env, ctx) {
  const raw = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET) {
    await logEvent(env, 'webhook_ignored', null, 'STRIPE_WEBHOOK_SECRET non configuré');
    err(503, 'Webhook Stripe non configuré (secret de signature)');
  }
  if (!(await verifySignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    await logEvent(env, 'webhook_rejected', null, 'Stripe : signature invalide');
    err(400, 'Signature du webhook invalide');
  }
  let event;
  try { event = JSON.parse(raw); } catch { err(400, 'JSON invalide'); }
  const obj = (event.data || {}).object || {};
  const origin = new URL(request.url).origin;
  try {
    if (event.type === 'checkout.session.completed' && obj.payment_status === 'paid') {
      await fulfillSession(env, ctx, obj, origin);
    } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : (obj.payment_intent || {}).id;
      const lic = pi ? await getLicenseByPaymentIntent(env, pi) : null;
      if (lic) {
        await env.DB.prepare("UPDATE licenses SET status='revoked' WHERE id=?").bind(lic.id).run();
        await logEvent(env, 'refund', lic.id, `Stripe ${event.type} · licence désactivée automatiquement`);
      }
    }
  } catch (e) {
    await logEvent(env, 'webhook_error', null, `Stripe ${event.type} : ${String(e.message || e).slice(0, 200)}`);
  }
  return json({ received: true });
}

/** Diagnostic (écran Réglages). */
export async function stripeHealth(env, test = false) {
  const out = { configured: stripeConfigured(env), webhook_set: !!env.STRIPE_WEBHOOK_SECRET, live: /^sk_live_/.test(env.STRIPE_SECRET_KEY || '') };
  if (test && out.configured) {
    try {
      const r = await stripeApi(env, 'GET', '/v1/balance');
      out.test = r.ok ? { ok: true } : { ok: false, error: ((r.data || {}).error || {}).message || `Stripe ${r.status}` };
    } catch (e) {
      const m = String(e.message || e);
      out.test = { ok: false, error: /fetch failed|network/i.test(m) ? 'Impossible de joindre Stripe depuis le serveur (réseau). Réessayez.' : m };
    }
  }
  return out;
}

