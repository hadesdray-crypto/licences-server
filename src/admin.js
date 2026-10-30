// API d'administration (utilisée par l'application mobile "Mes licences")

import { json, err, readJson, nowIso, addDays, isEmail, cleanEmail, clampInt, fmtDuration } from './util.js';
import { login, requireAdmin, changePassword, passwordConfigured, signLink, firstRunSetup } from './auth.js';
import {
  getProduct, listOffers, getLicense, listDevices, licenseView, createLicense, upsertCustomer, logEvent,
  METHOD_CATALOG, methodLabel, enabledManualMethods,
} from './db.js';
import { emailProvider, emailConfigured, sendLicenseEmail, sendEmail } from './email.js';
import { paypalHealth } from './paypal.js';
import { stripeHealth } from './stripe.js';
import { ALL_SETTINGS, SECRET_SETTINGS, SETTING_TO_ENV, setSetting, deleteSetting } from './settings.js';

export const VERSION = '1.2.0';

export async function handleAdminApi(request, env, ctx, path, url) {
  const m = request.method;
  if (path === '/status' && m === 'GET') return json({ ok: true, name: env.APP_NAME || 'Mes licences', version: VERSION, needs_setup: !passwordConfigured(env) });
  if (path === '/setup' && m === 'POST') return firstRunSetup(request, env);
  if (path === '/login' && m === 'POST') return login(request, env);

  await requireAdmin(request, env);
  const q = url.searchParams;
  let mm;

  if (path === '/me') return json({ ok: true, name: env.APP_NAME || 'Mes licences', version: VERSION });
  if (path === '/health') return health(env, q.get('test') === '1', url.origin);
  if (path === '/stats') return stats(env);
  if (path === '/finances') return finances(env);
  if (path === '/export/sales.csv' && m === 'GET') return exportSales(env);
  if (path === '/password' && m === 'POST') return changePassword(request, env);
  if (path === '/settings' && m === 'GET') return getSettings(env);
  if (path === '/settings' && m === 'PUT') return putSettings(env, await readJson(request));
  if (path === '/test-email' && m === 'POST') return testEmail(env, await readJson(request));

  // Applications (produits)
  if (path === '/products' && m === 'GET') return listProducts(env);
  if (path === '/products' && m === 'POST') return saveProduct(env, await readJson(request), null);
  if ((mm = path.match(/^\/products\/(\d+)$/))) {
    const id = Number(mm[1]);
    if (m === 'GET') return productDetail(env, id);
    if (m === 'PUT') return saveProduct(env, await readJson(request), id);
    if (m === 'DELETE') return deleteProduct(env, id);
  }

  // Réserve de clés (vente hors connexion)
  if (path === '/stock' && m === 'GET') return listStock(env);
  if (path === '/stock' && m === 'POST') return createStock(env, await readJson(request));

  // Commandes à valider (paiements manuels)
  if (path === '/orders' && m === 'GET') return listOrders(env, q);
  if ((mm = path.match(/^\/orders\/(\d+)\/(paid|cancel|reopen)$/)) && m === 'POST') return orderAction(env, ctx, Number(mm[1]), mm[2], await readJson(request).catch(() => ({})), url.origin);
  if (path === '/payment-methods' && m === 'GET') return json({ catalog: METHOD_CATALOG, enabled: enabledManualMethods(env), labels: Object.fromEntries([...METHOD_CATALOG.map((c) => [c.id, c.label]), ['paypal', 'PayPal'], ['stripe', 'Carte bancaire (Stripe)']]) });

  // Licences
  if (path === '/licenses' && m === 'GET') return listLicenses(env, q);
  if (path === '/licenses' && m === 'POST') return createManualLicense(env, ctx, await readJson(request), url.origin);
  if ((mm = path.match(/^\/licenses\/(\d+)$/)) && m === 'GET') return licenseDetail(env, Number(mm[1]));
  if ((mm = path.match(/^\/licenses\/(\d+)\/devices\/(\d+)$/)) && m === 'DELETE') return removeDevice(env, Number(mm[1]), Number(mm[2]));
  if ((mm = path.match(/^\/licenses\/(\d+)\/receipt-link$/)) && m === 'POST') return receiptLink(env, Number(mm[1]), url.origin);
  if ((mm = path.match(/^\/licenses\/(\d+)\/([a-z_]+)$/)) && m === 'POST') {
    return licenseAction(env, ctx, Number(mm[1]), mm[2], await readJson(request).catch(() => ({})), url.origin);
  }

  // Clients
  if (path === '/customers' && m === 'GET') return listCustomers(env, q);
  if ((mm = path.match(/^\/customers\/(\d+)$/)) && m === 'GET') return customerDetail(env, Number(mm[1]));
  if ((mm = path.match(/^\/customers\/(\d+)$/)) && m === 'PUT') return updateCustomer(env, Number(mm[1]), await readJson(request));

  // Journal
  if (path === '/events' && m === 'GET') return listEvents(env, q);

  err(404, 'Route admin introuvable');
}

// ---------- Diagnostic, réglages & statistiques ----------

async function health(env, test, origin) {
  let dbOk = true, counts = {};
  try {
    counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM licenses) AS licenses,
              (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM devices) AS devices`,
    ).first();
  } catch { dbOk = false; }
  const s = env.settings || {};
  return json({
    version: VERSION,
    server_time: nowIso(),
    server_url: origin,
    app_name: env.APP_NAME || 'Mes licences',
    currency: env.CURRENCY || 'EUR',
    db_ok: dbOk,
    counts,
    admin_password_set: passwordConfigured(env),
    password_in_app: !!s.admin_password_hash,
    signing_secret_set: !!env.SIGNING_SECRET,
    paypal: await paypalHealth(env, test),
    stripe: await stripeHealth(env, test),
    manual_methods: enabledManualMethods(env).map((x) => x.id),
    email: { provider: emailProvider(env), from: env.EMAIL_FROM || '', from_name: env.EMAIL_FROM_NAME || '', configured: emailConfigured(env) },
    seller_set: !!s.seller_name,
    webhook_url: `${origin}/api/paypal/webhook`,
    stripe_webhook_url: `${origin}/api/stripe/webhook`,
    go_url: `${origin}/go`,
  });
}

/** Réglages : les secrets ne sont jamais renvoyés, seulement "défini" ou non. */
async function getSettings(env) {
  const s = env.settings || {};
  const out = {};
  for (const key of ALL_SETTINGS) {
    if (SECRET_SETTINGS.includes(key)) {
      const envName = SETTING_TO_ENV[key];
      out[key + '_set'] = !!(s[key] || (envName && env[envName]));
      out[key + '_in_app'] = !!s[key];
    } else {
      const envName = SETTING_TO_ENV[key];
      out[key] = s[key] || (envName && env[envName] ? env[envName] : '');
      out[key + '_in_app'] = s[key] !== undefined;
    }
  }
  return json({ settings: out });
}

async function putSettings(env, body) {
  const changed = [];
  for (const [key, value] of Object.entries(body || {})) {
    if (!ALL_SETTINGS.includes(key)) continue;
    if (key === 'admin_password_hash' || key === 'signing_secret') continue; // jamais via l'API
    if (value === null) { await deleteSetting(env, key); changed.push(key); continue; }
    let v = String(value).trim();
    if (SECRET_SETTINGS.includes(key) && !v) continue; // secret vide = inchangé
    if (key === 'paypal_env') v = v === 'live' ? 'live' : 'sandbox';
    if (key === 'manual_methods') {
      let arr;
      try { arr = JSON.parse(v || '[]'); } catch { err(400, 'Moyens de paiement : format invalide'); }
      if (!Array.isArray(arr)) err(400, 'Moyens de paiement : format invalide');
      v = JSON.stringify(arr.filter((x) => x && METHOD_CATALOG.some((c) => c.id === x.id)).map((x) => ({ id: x.id, enabled: !!x.enabled, instructions: String(x.instructions || '').slice(0, 1000) })));
    }
    if (key === 'currency') v = (v || 'EUR').toUpperCase().slice(0, 3);
    if ((key === 'email_from' || key === 'seller_email') && v && !isEmail(v)) err(400, `Adresse email invalide (${key})`);
    await setSetting(env, key, v);
    changed.push(key);
  }
  if (changed.length) await logEvent(env, 'settings', null, changed.join(', '));
  return json({ ok: true, changed });
}

async function stats(env) {
  const now = nowIso();
  const monthStart = now.slice(0, 7) + '-01T00:00:00.000Z';
  const in7 = addDays(now, 7);
  const today = now.slice(0, 10);
  const sevenDaysAgo = addDays(now, -7).slice(0, 10);

  const main = await env.DB.prepare(
    `SELECT
      (SELECT COALESCE(SUM(price_cents),0) FROM licenses WHERE created_at >= ?) AS revenue_month,
      (SELECT COALESCE(SUM(price_cents),0) FROM licenses) AS revenue_total,
      (SELECT COUNT(*) FROM licenses WHERE created_at >= ? AND price_cents > 0) AS sales_month,
      (SELECT COUNT(*) FROM licenses WHERE status='active' AND activated_at IS NOT NULL AND (expires_at IS NULL OR expires_at >= ?)) AS active,
      (SELECT COUNT(*) FROM licenses WHERE status='active' AND activated_at IS NULL AND source <> 'stock') AS pending,
      (SELECT COUNT(*) FROM licenses WHERE status='active' AND source='stock') AS stock,
      (SELECT COUNT(*) FROM licenses WHERE status='active' AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at < ?) AS expiring_7d,
      (SELECT COUNT(*) FROM licenses WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?) AS expired,
      (SELECT COUNT(*) FROM licenses WHERE status='revoked') AS revoked,
      (SELECT COUNT(*) FROM customers) AS customers,
      (SELECT COUNT(*) FROM products WHERE active=1) AS products,
      (SELECT COALESCE(requests,0) FROM stats_daily WHERE day=?) AS requests_today,
      (SELECT COALESCE(SUM(requests),0) FROM stats_daily WHERE day >= ?) AS requests_7d,
      (SELECT COUNT(*) FROM events WHERE type IN ('paypal_error','stripe_error','webhook_error','webhook_rejected','email_failed') AND created_at >= ?) AS errors_7d,
      (SELECT COUNT(*) FROM orders WHERE status='pending') AS orders_pending`,
  ).bind(monthStart, monthStart, now, now, in7, now, today, sevenDaysAgo, addDays(now, -7)).first();

  const months = (await env.DB.prepare(
    `SELECT substr(created_at,1,7) AS month, COALESCE(SUM(price_cents),0) AS revenue, COUNT(*) AS count
     FROM licenses WHERE created_at >= ? AND source <> 'stock' GROUP BY month ORDER BY month`,
  ).bind(addDays(now, -180).slice(0, 7) + '-01').all()).results || [];

  const byProduct = (await env.DB.prepare(
    `SELECT p.id, p.name, COUNT(l.id) AS licenses, COALESCE(SUM(l.price_cents),0) AS revenue,
            SUM(CASE WHEN l.status='active' AND l.activated_at IS NOT NULL AND (l.expires_at IS NULL OR l.expires_at >= ?) THEN 1 ELSE 0 END) AS active
     FROM products p LEFT JOIN licenses l ON l.product_id = p.id AND l.source <> 'stock' GROUP BY p.id ORDER BY revenue DESC, p.name`,
  ).bind(now).all()).results || [];

  const events = await recentEvents(env, 12, false);
  return json({ ...main, months, by_product: byProduct, events, server_time: now });
}

/** Finances : 12 mois, par application, par mode de paiement, estimation des frais PayPal, meilleurs clients. */
async function finances(env) {
  const now = nowIso();
  const s = env.settings || {};
  const feePct = parseFloat(s.paypal_fee_pct || '2.9');
  const feeFixed = Math.round(parseFloat(s.paypal_fee_fixed || '0.35') * 100);
  const sFeePct = parseFloat(s.stripe_fee_pct || '1.5');
  const sFeeFixed = Math.round(parseFloat(s.stripe_fee_fixed || '0.25') * 100);
  const fees = (r) => Math.round((r.paypal_revenue || 0) * feePct / 100) + (r.paypal_count || 0) * feeFixed + Math.round((r.stripe_revenue || 0) * sFeePct / 100) + (r.stripe_count || 0) * sFeeFixed;
  const since = addDays(now, -365).slice(0, 7) + '-01';

  const months = (await env.DB.prepare(
    `SELECT substr(created_at,1,7) AS month,
            COALESCE(SUM(price_cents),0) AS revenue, COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN source='paypal' THEN price_cents ELSE 0 END),0) AS paypal_revenue,
            SUM(CASE WHEN source='paypal' THEN 1 ELSE 0 END) AS paypal_count,
            COALESCE(SUM(CASE WHEN source='stripe' THEN price_cents ELSE 0 END),0) AS stripe_revenue,
            SUM(CASE WHEN source='stripe' THEN 1 ELSE 0 END) AS stripe_count,
            COALESCE(SUM(CASE WHEN source NOT IN ('paypal','stripe') THEN price_cents ELSE 0 END),0) AS manual_revenue
     FROM licenses WHERE created_at >= ? AND source <> 'stock' AND price_cents > 0 GROUP BY month ORDER BY month`,
  ).bind(since).all()).results || [];
  for (const mo of months) {
    mo.paypal_fees = fees(mo);
    mo.net = mo.revenue - mo.paypal_fees;
  }

  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(price_cents),0) AS revenue, COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN source='paypal' THEN price_cents ELSE 0 END),0) AS paypal_revenue,
            SUM(CASE WHEN source='paypal' THEN 1 ELSE 0 END) AS paypal_count,
            COALESCE(SUM(CASE WHEN source='stripe' THEN price_cents ELSE 0 END),0) AS stripe_revenue,
            SUM(CASE WHEN source='stripe' THEN 1 ELSE 0 END) AS stripe_count,
            COALESCE(SUM(CASE WHEN source NOT IN ('paypal','stripe') THEN price_cents ELSE 0 END),0) AS manual_revenue,
            SUM(CASE WHEN source NOT IN ('paypal','stripe') THEN 1 ELSE 0 END) AS manual_count,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN price_cents ELSE 0 END),0) AS revenue_year,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN price_cents ELSE 0 END),0) AS revenue_month,
            COALESCE(SUM(CASE WHEN status='revoked' THEN price_cents ELSE 0 END),0) AS revoked_revenue
     FROM licenses WHERE source <> 'stock' AND price_cents > 0`,
  ).bind(now.slice(0, 4) + '-01-01', now.slice(0, 7) + '-01').first();
  totals.paypal_fees = fees(totals);
  totals.net = totals.revenue - totals.paypal_fees;
  totals.average = totals.count ? Math.round(totals.revenue / totals.count) : 0;

  const byMethod = ((await env.DB.prepare(
    `SELECT CASE WHEN payment_method <> '' THEN payment_method WHEN source='paypal' THEN 'paypal' WHEN source='stripe' THEN 'stripe' ELSE 'autre' END AS method,
            COUNT(*) AS count, COALESCE(SUM(price_cents),0) AS revenue
     FROM licenses WHERE source <> 'stock' AND price_cents > 0 GROUP BY method ORDER BY revenue DESC`,
  ).all()).results || []).map((r) => ({ ...r, label: methodLabel(r.method) }));
  const pendingOrders = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS amount FROM orders WHERE status='pending'").first();

  const byProduct = (await env.DB.prepare(
    `SELECT p.id, p.name, COUNT(l.id) AS count, COALESCE(SUM(l.price_cents),0) AS revenue
     FROM products p LEFT JOIN licenses l ON l.product_id = p.id AND l.source <> 'stock' AND l.price_cents > 0
     GROUP BY p.id ORDER BY revenue DESC`,
  ).all()).results || [];

  const byOffer = (await env.DB.prepare(
    `SELECT p.name AS product_name, l.offer_label, COUNT(*) AS count, COALESCE(SUM(l.price_cents),0) AS revenue
     FROM licenses l JOIN products p ON p.id=l.product_id WHERE l.source <> 'stock' AND l.price_cents > 0
     GROUP BY p.name, l.offer_label ORDER BY revenue DESC LIMIT 12`,
  ).all()).results || [];

  const topCustomers = (await env.DB.prepare(
    `SELECT c.id, c.email, c.name, COUNT(l.id) AS count, COALESCE(SUM(l.price_cents),0) AS revenue
     FROM customers c JOIN licenses l ON l.customer_id = c.id WHERE l.price_cents > 0
     GROUP BY c.id ORDER BY revenue DESC LIMIT 5`,
  ).all()).results || [];

  const refunds = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE type='refund' AND created_at >= ?`,
  ).bind(now.slice(0, 4) + '-01-01').first()).n;

  return json({ months, totals, by_product: byProduct, by_offer: byOffer, by_method: byMethod, top_customers: topCustomers, refunds_year: refunds, pending_orders: pendingOrders, fee_pct: feePct, fee_fixed_cents: feeFixed, stripe_fee_pct: sFeePct, stripe_fee_fixed_cents: sFeeFixed, server_time: now });
}

/** Export CSV de toutes les ventes (pour le comptable / tableur). */
async function exportSales(env) {
  const rows = (await env.DB.prepare(
    `SELECT l.id, l.created_at, p.name AS product, l.offer_label, l.duration_days, l.price_cents, l.source, l.payment_method, l.paypal_order_id, l.stripe_session_id,
            c.email AS customer_email, c.name AS customer_name, l.status, l.activated_at, l.expires_at, l.key, l.note
     FROM licenses l JOIN products p ON p.id=l.product_id LEFT JOIN customers c ON c.id=l.customer_id
     WHERE l.source <> 'stock' ORDER BY l.id`,
  ).all()).results || [];
  const esc = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['N°', 'Date', 'Application', 'Formule', 'Durée (jours)', 'Prix (€)', 'Paiement', 'Référence paiement', 'Email client', 'Nom client', 'État', 'Activée le', 'Expire le', 'Clé', 'Note'];
  const lines = [head.join(';')];
  for (const r of rows) {
    lines.push([
      r.id, r.created_at.slice(0, 10), r.product, r.offer_label, r.duration_days, (r.price_cents / 100).toFixed(2).replace('.', ','),
      methodLabel(r.payment_method || r.source), r.paypal_order_id || r.stripe_session_id || '', r.customer_email || '', r.customer_name || '',
      r.status === 'revoked' ? 'Désactivée' : 'Active', (r.activated_at || '').slice(0, 10), (r.expires_at || '').slice(0, 10), r.key, r.note,
    ].map(esc).join(';'));
  }
  return new Response('﻿' + lines.join('\r\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ventes-${nowIso().slice(0, 10)}.csv"`, 'access-control-allow-origin': '*' },
  });
}

async function recentEvents(env, limit, errorsOnly) {
  const where = errorsOnly ? "WHERE e.type IN ('paypal_error','stripe_error','webhook_error','webhook_rejected','webhook_ignored','email_failed','recover_failed')" : '';
  return (await env.DB.prepare(
    `SELECT e.*, l.key AS license_key, p.name AS product_name
     FROM events e LEFT JOIN licenses l ON l.id = e.license_id LEFT JOIN products p ON p.id = l.product_id
     ${where} ORDER BY e.id DESC LIMIT ?`,
  ).bind(limit).all()).results || [];
}

async function listEvents(env, q) {
  return json({ events: await recentEvents(env, clampInt(q.get('limit'), 1, 300, 50), q.get('errors') === '1') });
}

// ---------- Applications ----------

async function listProducts(env) {
  const products = (await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM licenses l WHERE l.product_id=p.id AND l.source <> 'stock') AS licenses_count,
            (SELECT COUNT(*) FROM licenses l WHERE l.product_id=p.id AND l.source = 'stock' AND l.status='active') AS stock_count,
            (SELECT COALESCE(SUM(price_cents),0) FROM licenses l WHERE l.product_id=p.id) AS revenue
     FROM products p ORDER BY p.active DESC, p.name`,
  ).all()).results || [];
  for (const p of products) p.offers = await listOffers(env, p.id);
  return json({ products });
}

async function productDetail(env, id) {
  const product = await getProduct(env, id);
  if (!product) err(404, 'Application introuvable');
  product.offers = await listOffers(env, id);
  return json({ product });
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

async function saveProduct(env, body, id) {
  const name = String(body.name || '').trim();
  if (!name) err(400, 'Le nom de l\'application est obligatoire');
  const slug = slugify(body.slug || name);
  if (!slug) err(400, 'Identifiant (slug) invalide');
  const key_prefix = String(body.key_prefix || slug).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'APP';
  const description = String(body.description || '').trim();
  const download_url = String(body.download_url || '').trim();
  const version = String(body.version || '').trim().slice(0, 30);
  const changelog = String(body.changelog || '').trim().slice(0, 2000);
  const max_devices = clampInt(body.max_devices, 1, 100, 2);
  const active = body.active === false || body.active === 0 ? 0 : 1;
  const offers = Array.isArray(body.offers) ? body.offers : [];

  for (const o of offers) {
    if (!String(o.label || '').trim()) err(400, 'Chaque offre doit avoir un libellé (ex : 1 an)');
    if (!(Number(o.days) >= 0)) err(400, 'Durée invalide pour l\'offre ' + o.label);
    if (!(Number(o.price_cents) >= 0)) err(400, 'Prix invalide pour l\'offre ' + o.label);
  }

  let versionChanged = false;
  try {
    if (id) {
      const before = await getProduct(env, id);
      versionChanged = before && version && before.version !== version;
      await env.DB.prepare(
        'UPDATE products SET slug=?, name=?, description=?, download_url=?, key_prefix=?, max_devices=?, version=?, changelog=?, active=? WHERE id=?',
      ).bind(slug, name, description, download_url, key_prefix, max_devices, version, changelog, active, id).run();
    } else {
      const row = await env.DB.prepare(
        'INSERT INTO products(slug, name, description, download_url, key_prefix, max_devices, version, changelog, active) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
      ).bind(slug, name, description, download_url, key_prefix, max_devices, version, changelog, active).first();
      id = row.id;
      await logEvent(env, 'product_created', null, name);
    }
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) err(409, `L'identifiant « ${slug} » est déjà utilisé par une autre application`);
    throw e;
  }
  if (versionChanged) await logEvent(env, 'product_update', null, `${name} → version ${version}`);

  // Offres : mise à jour, création, et désactivation de celles qui ont disparu
  const existing = await listOffers(env, id);
  const keep = new Set();
  for (let i = 0; i < offers.length; i++) {
    const o = offers[i];
    const label = String(o.label).trim().slice(0, 60);
    const days = Math.round(Number(o.days));
    const price = Math.round(Number(o.price_cents));
    if (o.id && existing.some((e) => e.id === Number(o.id))) {
      await env.DB.prepare('UPDATE offers SET label=?, days=?, price_cents=?, active=1, sort=? WHERE id=? AND product_id=?')
        .bind(label, days, price, i, Number(o.id), id).run();
      keep.add(Number(o.id));
    } else {
      const row = await env.DB.prepare('INSERT INTO offers(product_id, label, days, price_cents, active, sort) VALUES(?,?,?,?,1,?) RETURNING id')
        .bind(id, label, days, price, i).first();
      keep.add(row.id);
    }
  }
  for (const e of existing) {
    if (!keep.has(e.id)) await env.DB.prepare('UPDATE offers SET active=0 WHERE id=?').bind(e.id).run();
  }

  return productDetail(env, id);
}

async function deleteProduct(env, id) {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM licenses WHERE product_id=? AND source <> 'stock'").bind(id).first()).n;
  if (n > 0) err(409, `Impossible de supprimer : ${n} licence(s) existent pour cette application. Désactivez-la plutôt.`);
  await env.DB.prepare("DELETE FROM licenses WHERE product_id=? AND source='stock'").bind(id).run();
  await env.DB.prepare('DELETE FROM offers WHERE product_id=?').bind(id).run();
  await env.DB.prepare('DELETE FROM products WHERE id=?').bind(id).run();
  return json({ ok: true });
}

// ---------- Réserve de clés (pour vendre sans connexion) ----------

async function listStock(env) {
  const rows = (await env.DB.prepare(
    `SELECT l.id, l.key, l.product_id, l.duration_days, l.max_devices, l.offer_label, l.created_at,
            p.name AS product_name, p.slug AS product_slug, p.download_url
     FROM licenses l JOIN products p ON p.id=l.product_id
     WHERE l.source='stock' AND l.status='active' AND l.activated_at IS NULL ORDER BY p.name, l.duration_days, l.id`,
  ).all()).results || [];
  return json({ stock: rows });
}

async function createStock(env, body) {
  const product = await getProduct(env, Number(body.product_id));
  if (!product) err(404, 'Application introuvable');
  const days = clampInt(body.days, 0, 36500, null);
  if (days === null) err(400, 'Durée invalide');
  const count = clampInt(body.count, 1, 50, 5);
  const created = [];
  for (let i = 0; i < count; i++) {
    const lic = await createLicense(env, {
      product, duration_days: days, max_devices: product.max_devices, source: 'stock',
      offer_label: fmtDuration(days).replace(/^./, (c) => c.toUpperCase()), note: '',
    });
    created.push(lic.key);
  }
  await logEvent(env, 'stock_created', null, `${count} clé(s) ${product.name} · ${fmtDuration(days)}`);
  return listStock(env);
}

// ---------- Commandes à valider (paiements manuels) ----------

async function listOrders(env, q) {
  const status = q.get('status') || 'pending';
  const where = status === 'all' ? '1=1' : 'o.status = ?';
  const params = status === 'all' ? [] : [status];
  const rows = (await env.DB.prepare(
    `SELECT o.*, p.name AS product_name, p.slug AS product_slug, l.key AS license_key
     FROM orders o JOIN products p ON p.id=o.product_id LEFT JOIN licenses l ON l.id=o.license_id
     WHERE ${where} ORDER BY o.id DESC LIMIT 200`,
  ).bind(...params).all()).results || [];
  return json({ orders: rows.map((o) => ({ ...o, method_label: methodLabel(o.method) })) });
}

async function orderAction(env, ctx, id, action, body, origin) {
  const order = await env.DB.prepare('SELECT o.*, p.name AS product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?').bind(id).first();
  if (!order) err(404, 'Commande introuvable');
  const now = nowIso();
  if (action === 'paid') {
    if (order.status === 'paid' && order.license_id) return json({ order, license: licenseView(await getLicense(env, order.license_id)) });
    const product = await getProduct(env, order.product_id);
    const amount = clampInt(body.amount_cents, 0, 100000000, order.amount_cents);
    const customer = order.email ? await upsertCustomer(env, order.email, order.name) : null;
    const license = await createLicense(env, {
      product, customer_id: customer ? customer.id : null, offer_label: order.offer_label, duration_days: order.duration_days,
      max_devices: product.max_devices, price_cents: amount, source: 'manual', payment_method: order.method, note: `Commande ${order.ref}`,
    });
    await env.DB.prepare("UPDATE orders SET status='paid', paid_at=?, license_id=?, amount_cents=? WHERE id=?").bind(now, license.id, amount, id).run();
    await logEvent(env, 'order_paid', license.id, `${order.ref} · ${methodLabel(order.method)} · ${(amount / 100).toFixed(2)} €`);
    let email_sent = null;
    if (body.send_email !== false && customer) {
      const r = await sendLicenseEmail(env, { to: customer.email, license, product, buyUrl: `${origin}/buy/${product.slug}` });
      email_sent = r.ok ? true : r.error;
    }
    return json({ order: { ...order, status: 'paid', license_id: license.id }, license: licenseView(license), email_sent });
  }
  if (action === 'cancel') {
    if (order.status === 'paid') err(409, 'Commande déjà payée : désactivez plutôt la licence.');
    await env.DB.prepare("UPDATE orders SET status='cancelled', note=? WHERE id=?").bind(String(body.reason || '').slice(0, 200), id).run();
    await logEvent(env, 'order_cancelled', null, `${order.ref}${body.reason ? ' · ' + body.reason : ''}`);
    return json({ ok: true });
  }
  if (action === 'reopen') {
    if (order.status !== 'cancelled') err(409, 'Seule une commande annulée peut être rouverte');
    await env.DB.prepare("UPDATE orders SET status='pending' WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  err(404, 'Action inconnue');
}

// ---------- Licences ----------

function stateClause(state, now) {
  switch (state) {
    case 'active': return { sql: "l.status='active' AND l.activated_at IS NOT NULL AND (l.expires_at IS NULL OR l.expires_at >= ?)", params: [now] };
    case 'pending': return { sql: "l.status='active' AND l.activated_at IS NULL AND l.source <> 'stock'", params: [] };
    case 'expired': return { sql: "l.status='active' AND l.expires_at IS NOT NULL AND l.expires_at < ?", params: [now] };
    case 'expiring': return { sql: "l.status='active' AND l.expires_at IS NOT NULL AND l.expires_at >= ? AND l.expires_at < ?", params: [now, addDays(now, 7)] };
    case 'revoked': return { sql: "l.status='revoked'", params: [] };
    case 'stock': return { sql: "l.source='stock' AND l.status='active'", params: [] };
    default: return null;
  }
}

async function listLicenses(env, q) {
  const now = nowIso();
  const where = [];
  const params = [];
  const search = (q.get('q') || '').trim();
  if (search) {
    where.push('(l.key LIKE ? OR c.email LIKE ? OR c.name LIKE ? OR l.note LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const product = Number(q.get('product'));
  if (product) { where.push('l.product_id = ?'); params.push(product); }
  const st = stateClause(q.get('state'), now);
  if (st) { where.push(st.sql); params.push(...st.params); }
  else if (!search) where.push("l.source <> 'stock'"); // la réserve n'apparaît pas dans la liste normale
  const customer = Number(q.get('customer'));
  if (customer) { where.push('l.customer_id = ?'); params.push(customer); }
  if (!where.length) where.push('1=1');

  const limit = clampInt(q.get('limit'), 1, 200, 50);
  const page = clampInt(q.get('page'), 1, 100000, 1);
  const sql = `
    SELECT l.*, p.name AS product_name, p.slug AS product_slug, c.email AS customer_email, c.name AS customer_name,
           (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id) AS devices_used
    FROM licenses l JOIN products p ON p.id = l.product_id LEFT JOIN customers c ON c.id = l.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
  const rows = (await env.DB.prepare(sql).bind(...params).all()).results || [];
  const countSql = `SELECT COUNT(*) AS n FROM licenses l JOIN products p ON p.id=l.product_id LEFT JOIN customers c ON c.id=l.customer_id WHERE ${where.join(' AND ')}`;
  const total = (await env.DB.prepare(countSql).bind(...params).first()).n;
  return json({ licenses: rows.map((r) => licenseView(r, now)), total, page, limit });
}

async function licenseDetail(env, id) {
  const lic = await getLicense(env, id);
  if (!lic) err(404, 'Licence introuvable');
  const v = licenseView(lic);
  v.devices = await listDevices(env, id);
  v.events = (await env.DB.prepare('SELECT * FROM events WHERE license_id=? ORDER BY id DESC LIMIT 30').bind(id).all()).results || [];
  return json({ license: v });
}

async function createManualLicense(env, ctx, body, origin) {
  const product = await getProduct(env, Number(body.product_id));
  if (!product) err(404, 'Application introuvable');
  const days = clampInt(body.days, 0, 36500, null);
  if (days === null) err(400, 'Durée (jours) invalide. 0 = à vie.');
  const max_devices = clampInt(body.max_devices, 1, 100, product.max_devices);
  const price_cents = clampInt(body.price_cents, 0, 100000000, 0);
  const note = String(body.note || '').trim().slice(0, 500);
  let customer = null;
  if (body.email) {
    if (!isEmail(body.email)) err(400, 'Adresse email invalide');
    customer = await upsertCustomer(env, body.email, body.name);
  }
  const offer_label = String(body.offer_label || '').trim() || fmtDuration(days).replace(/^./, (c) => c.toUpperCase());
  const payment_method = String(body.payment_method || '').trim().slice(0, 30);
  const license = await createLicense(env, {
    product, customer_id: customer ? customer.id : null, offer_label, duration_days: days, max_devices, price_cents, source: 'manual', note, payment_method,
  });
  let email_sent = null;
  if (body.send_email && customer) {
    const r = await sendLicenseEmail(env, { to: customer.email, license, product, buyUrl: `${origin}/buy/${product.slug}` });
    email_sent = r.ok ? true : r.error;
  }
  return json({ license: licenseView(license), email_sent });
}

async function receiptLink(env, id, origin) {
  const lic = await getLicense(env, id);
  if (!lic) err(404, 'Licence introuvable');
  const token = await signLink(env, 'receipt', id, 24 * 365);
  return json({ url: `${origin}/r/${id}?t=${encodeURIComponent(token)}` });
}

async function licenseAction(env, ctx, id, action, body, origin) {
  const lic = await getLicense(env, id);
  if (!lic) err(404, 'Licence introuvable');
  const now = nowIso();

  switch (action) {
    case 'revoke':
      await env.DB.prepare("UPDATE licenses SET status='revoked' WHERE id=?").bind(id).run();
      await logEvent(env, 'revoke', id, body.reason ? String(body.reason).slice(0, 200) : 'par l\'administrateur');
      break;
    case 'reactivate':
      await env.DB.prepare("UPDATE licenses SET status='active' WHERE id=?").bind(id).run();
      await logEvent(env, 'reactivate', id, '');
      break;
    case 'extend': {
      const days = clampInt(body.days, -36500, 36500, 0);
      if (!days) err(400, 'Nombre de jours invalide');
      if (!lic.activated_at) {
        await env.DB.prepare('UPDATE licenses SET duration_days=MAX(1, duration_days + ?) WHERE id=?').bind(days, id).run();
      } else {
        const base = lic.expires_at && lic.expires_at > now ? lic.expires_at : now;
        const target = lic.expires_at ? addDays(base, days) : null;
        if (target) await env.DB.prepare('UPDATE licenses SET expires_at=? WHERE id=?').bind(target, id).run();
      }
      await logEvent(env, 'extend', id, `${days > 0 ? '+' : ''}${days} jours`);
      break;
    }
    case 'set_expiry': {
      if (body.expires_at === null || body.expires_at === '') {
        await env.DB.prepare('UPDATE licenses SET expires_at=NULL, duration_days=0 WHERE id=?').bind(id).run();
        await logEvent(env, 'set_expiry', id, 'à vie');
      } else {
        const d = new Date(body.expires_at);
        if (Number.isNaN(d.getTime())) err(400, 'Date invalide');
        const iso = d.toISOString();
        await env.DB.prepare('UPDATE licenses SET expires_at=?, activated_at=COALESCE(activated_at, ?) WHERE id=?').bind(iso, now, id).run();
        await logEvent(env, 'set_expiry', id, iso.slice(0, 10));
      }
      break;
    }
    case 'set_max_devices': {
      const n = clampInt(body.max_devices, 1, 100, null);
      if (!n) err(400, 'Nombre d\'appareils invalide');
      await env.DB.prepare('UPDATE licenses SET max_devices=? WHERE id=?').bind(n, id).run();
      break;
    }
    case 'reset_devices':
      await env.DB.prepare('DELETE FROM devices WHERE license_id=?').bind(id).run();
      await logEvent(env, 'devices_reset', id, '');
      break;
    case 'note':
      await env.DB.prepare('UPDATE licenses SET note=? WHERE id=?').bind(String(body.note || '').slice(0, 500), id).run();
      break;
    case 'set_payment_method':
      await env.DB.prepare('UPDATE licenses SET payment_method=? WHERE id=?').bind(String(body.payment_method || '').slice(0, 30), id).run();
      break;
    case 'set_price': {
      const p = clampInt(body.price_cents, 0, 100000000, null);
      if (p === null) err(400, 'Prix invalide');
      await env.DB.prepare('UPDATE licenses SET price_cents=? WHERE id=?').bind(p, id).run();
      break;
    }
    case 'set_customer': {
      if (!body.email) {
        await env.DB.prepare('UPDATE licenses SET customer_id=NULL WHERE id=?').bind(id).run();
      } else {
        if (!isEmail(body.email)) err(400, 'Adresse email invalide');
        const c = await upsertCustomer(env, body.email, body.name);
        await env.DB.prepare('UPDATE licenses SET customer_id=? WHERE id=?').bind(c.id, id).run();
      }
      break;
    }
    case 'mark_sold': {
      // Clé de la réserve remise à un client (vente faite hors connexion puis synchronisée)
      const price = clampInt(body.price_cents, 0, 100000000, 0);
      let customerId = lic.customer_id;
      if (body.email) {
        if (!isEmail(body.email)) err(400, 'Adresse email invalide');
        customerId = (await upsertCustomer(env, body.email, body.name)).id;
      }
      await env.DB.prepare("UPDATE licenses SET source='manual', price_cents=?, customer_id=?, note=?, created_at=?, payment_method=? WHERE id=?")
        .bind(price, customerId, String(body.note || 'Vente rapide').slice(0, 500), body.sold_at ? new Date(body.sold_at).toISOString() : lic.created_at, String(body.payment_method || '').slice(0, 30), id).run();
      await logEvent(env, 'sold', id, `${lic.product_name} · ${lic.offer_label}${price ? ' · ' + (price / 100).toFixed(2) + ' €' : ''}`);
      if (body.send_email && body.email) {
        const product = await getProduct(env, lic.product_id);
        ctx.waitUntil(sendLicenseEmail(env, { to: cleanEmail(body.email), license: lic, product, buyUrl: `${origin}/buy/${product.slug}` }));
      }
      break;
    }
    case 'resend_email': {
      const to = body.email ? cleanEmail(body.email) : lic.customer_email;
      if (!isEmail(to)) err(400, 'Aucune adresse email pour ce client');
      const product = await getProduct(env, lic.product_id);
      const r = await sendLicenseEmail(env, { to, license: lic, product, buyUrl: `${origin}/buy/${product.slug}` });
      if (!r.ok) err(502, `Envoi impossible : ${r.error}`);
      break;
    }
    case 'delete': {
      if (lic.source === 'paypal') err(409, 'Une licence payée via PayPal ne se supprime pas : désactivez-la.');
      await env.DB.prepare('DELETE FROM devices WHERE license_id=?').bind(id).run();
      await env.DB.prepare('DELETE FROM events WHERE license_id=?').bind(id).run();
      await env.DB.prepare('DELETE FROM licenses WHERE id=?').bind(id).run();
      return json({ ok: true, deleted: true });
    }
    default:
      err(404, `Action inconnue : ${action}`);
  }
  return licenseDetail(env, id);
}

async function removeDevice(env, licenseId, deviceRowId) {
  await env.DB.prepare('DELETE FROM devices WHERE id=? AND license_id=?').bind(deviceRowId, licenseId).run();
  await logEvent(env, 'device_removed', licenseId, 'par l\'administrateur');
  return licenseDetail(env, licenseId);
}

// ---------- Clients ----------

async function listCustomers(env, q) {
  const search = (q.get('q') || '').trim();
  const now = nowIso();
  const rows = (await env.DB.prepare(
    `SELECT c.*, COUNT(l.id) AS licenses_count, COALESCE(SUM(l.price_cents),0) AS total_paid, MAX(l.created_at) AS last_purchase,
            SUM(CASE WHEN l.status='active' AND (l.expires_at IS NULL OR l.expires_at >= ?) THEN 1 ELSE 0 END) AS active_count
     FROM customers c LEFT JOIN licenses l ON l.customer_id = c.id
     WHERE (? = '' OR c.email LIKE ? OR c.name LIKE ?)
     GROUP BY c.id ORDER BY last_purchase DESC NULLS LAST, c.email LIMIT 200`,
  ).bind(now, search, `%${search}%`, `%${search}%`).all()).results || [];
  return json({ customers: rows });
}

async function customerDetail(env, id) {
  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id=?').bind(id).first();
  if (!customer) err(404, 'Client introuvable');
  const now = nowIso();
  const rows = (await env.DB.prepare(
    `SELECT l.*, p.name AS product_name, p.slug AS product_slug,
            (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id) AS devices_used
     FROM licenses l JOIN products p ON p.id=l.product_id WHERE l.customer_id=? ORDER BY l.id DESC`,
  ).bind(id).all()).results || [];
  customer.licenses = rows.map((r) => licenseView(r, now));
  customer.total_paid = rows.reduce((s, r) => s + (r.price_cents || 0), 0);
  return json({ customer });
}

async function updateCustomer(env, id, body) {
  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id=?').bind(id).first();
  if (!customer) err(404, 'Client introuvable');
  const name = String(body.name ?? customer.name).trim().slice(0, 120);
  let email = customer.email;
  if (body.email !== undefined) {
    if (!isEmail(body.email)) err(400, 'Adresse email invalide');
    email = cleanEmail(body.email);
  }
  try {
    await env.DB.prepare('UPDATE customers SET name=?, email=? WHERE id=?').bind(name, email, id).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) err(409, 'Un autre client utilise déjà cette adresse email');
    throw e;
  }
  return customerDetail(env, id);
}

// ---------- Email de test ----------

async function testEmail(env, body) {
  if (!isEmail(body.to)) err(400, 'Adresse email invalide');
  const r = await sendEmail(env, {
    to: cleanEmail(body.to), subject: 'Test – serveur de licences',
    html: '<p>Félicitations, l\'envoi d\'emails fonctionne ! Vos clients recevront leurs clés automatiquement.</p>',
    text: 'Félicitations, l\'envoi d\'emails fonctionne !',
  });
  if (!r.ok) err(502, r.error || 'Envoi impossible');
  return json({ ok: true, provider: r.provider });
}
