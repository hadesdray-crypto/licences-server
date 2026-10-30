// Point d'entrée du serveur de licences (Cloudflare Worker)
//
//  /admin                 → application d'administration (PWA, français)
//  /admin/api/...         → API d'administration (mot de passe requis)
//  /api/...               → API publique utilisée par vos applications (activation, vérification)
//  /api/paypal/...        → paiement PayPal (commande, capture, webhook)
//  /buy/<slug>            → page de vente d'une application
//  /go                    → le client tape son code : lien de téléchargement, état de la licence
//  /order/<ref>?t=...     → suivi d'une commande payée « à la main » (la clé apparaît une fois validée)
//  /r/<id>?t=...          → reçu (lien signé)
//  /api/stripe/...        → paiement par carte (Stripe Checkout) + webhook

import { json, html, CORS, HttpError, escapeHtml, fmtCents, fmtDuration, fmtDateFr } from './util.js';
import { handleAdminApi } from './admin.js';
import { handlePublicApi } from './public.js';
import { handlePaypal } from './paypal.js';
import { handleStripe } from './stripe.js';
import { bumpStats, getProductBySlug, getLicense, ensureSchema } from './db.js';
import { withSettings } from './settings.js';
import { verifyLink } from './auth.js';

import adminHtml from './ui/admin.html';
import buyHtml from './ui/buy.html';
import goHtml from './ui/go.html';
import orderHtml from './ui/order.html';
import receiptHtml from './ui/receipt.html';
import swJs from './ui/sw.js.txt';
import icon192 from './ui/icon-192.png';
import icon512 from './ui/icon-512.png';

export default {
  async fetch(request, rawEnv, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (!rawEnv.DB) throw new Error('Base de données D1 non liée (binding DB). Lancez : npm run setup');

      // Fichiers statiques (pas besoin des réglages)
      if (path === '/admin' || path === '/admin/index.html') return html(adminHtml);
      if (path === '/sw.js') return new Response(swJs, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
      if (path === '/admin/icon-192.png') return png(icon192);
      if (path === '/admin/icon-512.png') return png(icon512);
      if (path === '/favicon.ico') return png(icon192);

      // Base de données prête (tables créées au premier démarrage, colonnes ajoutées lors des mises à jour)
      await ensureSchema(rawEnv);
      // Réglages saisis dans l'application (base) + variables Cloudflare
      const env = await withSettings(rawEnv);

      if (path === '/') return landing(env, url.origin);
      if (path === '/admin/manifest.json') return manifest(env);
      if (path === '/go') return html(goHtml.replaceAll('__BRAND__', escapeHtml(env.APP_NAME || 'Mes licences')).replaceAll('__ORIGIN__', escapeHtml(url.origin)));

      if (path.startsWith('/admin/api/')) return await handleAdminApi(request, env, ctx, path.slice('/admin/api'.length), url);

      if (path.startsWith('/api/paypal/')) {
        ctx.waitUntil(bumpStats(env));
        return await handlePaypal(request, env, ctx, path.slice('/api/paypal'.length));
      }
      if (path.startsWith('/api/stripe/')) {
        ctx.waitUntil(bumpStats(env));
        return await handleStripe(request, env, ctx, path.slice('/api/stripe'.length));
      }
      if (path.startsWith('/api/')) {
        ctx.waitUntil(bumpStats(env));
        return await handlePublicApi(request, env, ctx, path.slice('/api'.length), url);
      }
      if (path.startsWith('/buy/')) return await buyPage(env, path.slice('/buy/'.length), url.origin);
      if (path.startsWith('/r/')) return await receiptPage(env, path.slice('/r/'.length), url);
      if (path.startsWith('/order/')) {
        return html(orderHtml.replaceAll('__BRAND__', escapeHtml(env.APP_NAME || 'Mes licences')).replaceAll('__ORIGIN__', escapeHtml(url.origin))
          .replaceAll('__REF__', escapeHtml(path.slice('/order/'.length).split('/')[0].toUpperCase())).replaceAll('__TOKEN__', escapeHtml(url.searchParams.get('t') || '')));
      }

      return json({ error: 'Page introuvable' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error(e);
      const msg = String((e && e.message) || e);
      let hint = '';
      if (/no such table/i.test(msg)) hint = ' La base de données n\'est pas initialisée : lancez « npm run setup » (ou « npm run db:init »).';
      return json({ error: 'Erreur interne du serveur.' + hint, detail: msg }, 500);
    }
  },
};

function png(data) {
  return new Response(data, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}

function manifest(env) {
  const name = env.APP_NAME || 'Mes licences';
  return new Response(JSON.stringify({
    id: '/admin',
    name,
    short_name: name.length > 12 ? 'Licences' : name,
    description: 'Gestion des licences, des ventes et des clients',
    start_url: '/admin',
    scope: '/admin',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    lang: 'fr',
    icons: [
      { src: '/admin/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/admin/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/admin/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' } });
}

function landing(env, origin) {
  const name = escapeHtml(env.APP_NAME || 'Serveur de licences');
  return html(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.c{text-align:center;padding:32px}h1{font-size:22px;margin:0 0 8px}p{color:#94a3b8;margin:0 0 20px}a{display:inline-block;background:#10b981;color:#052e16;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;margin:4px}a.g{background:#1e293b;color:#e2e8f0}</style></head>
<body><div class="c"><h1>${name}</h1><p>Serveur en ligne ✓</p><a href="/go" class="g">J'ai un code d'accès</a> <a href="/admin">Administration</a></div></body></html>`);
}

async function buyPage(env, slug, origin) {
  const product = await getProductBySlug(env, slug.split('/')[0]);
  if (!product || !product.active) {
    return html(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Introuvable</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}</style></head>
<body><div><h1>Application introuvable</h1><p>Ce lien de vente n'existe pas ou n'est plus actif.</p></div></body></html>`, 404);
  }
  const page = buyHtml
    .replaceAll('__SLUG__', escapeHtml(product.slug))
    .replaceAll('__NAME__', escapeHtml(product.name))
    .replaceAll('__BRAND__', escapeHtml(env.APP_NAME || product.name))
    .replaceAll('__CLIENT_ID__', escapeHtml(env.PAYPAL_CLIENT_ID || ''))
    .replaceAll('__CURRENCY__', escapeHtml(env.CURRENCY || 'EUR'))
    .replaceAll('__ORIGIN__', escapeHtml(origin));
  return html(page);
}

/** Reçu imprimable, accessible via un lien signé généré depuis l'application. */
async function receiptPage(env, rest, url) {
  const id = Number(rest.split('/')[0]);
  const token = url.searchParams.get('t') || '';
  if (!id || !(await verifyLink(env, 'receipt', id, token))) return html('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:40px">Lien de reçu invalide ou expiré.</p>', 403);
  const lic = await getLicense(env, id);
  if (!lic) return html('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:40px">Reçu introuvable.</p>', 404);
  const s = env.settings || {};
  const number = `R-${lic.created_at.slice(0, 4)}-${String(lic.id).padStart(5, '0')}`;
  const contact = [s.seller_email, s.seller_phone].filter(Boolean).join(' · ');
  const customer = [lic.customer_name, lic.customer_email].filter(Boolean).join('<br>') || 'Client';
  const payment = lic.source === 'paypal' ? `Paiement PayPal${lic.paypal_order_id ? ' · réf. ' + escapeHtml(lic.paypal_order_id) : ''}` : 'Paiement reçu';
  const page = receiptHtml
    .replaceAll('__NUMBER__', escapeHtml(number))
    .replaceAll('__DATE__', escapeHtml(fmtDateFr(lic.created_at)))
    .replaceAll('__PAYMENT__', payment)
    .replaceAll('__SELLER_NAME__', escapeHtml(s.seller_name || env.APP_NAME || 'Vendeur'))
    .replaceAll('__SELLER_ADDRESS__', escapeHtml(s.seller_address || ''))
    .replaceAll('__SELLER_CONTACT__', escapeHtml(contact))
    .replaceAll('__SELLER_SIRET__', s.seller_siret ? 'SIRET ' + escapeHtml(s.seller_siret) : '')
    .replaceAll('__CUSTOMER__', customer)
    .replaceAll('__PRODUCT__', escapeHtml(lic.product_name))
    .replaceAll('__OFFER__', escapeHtml(lic.offer_label || fmtDuration(lic.duration_days)))
    .replaceAll('__KEY__', escapeHtml(lic.key))
    .replaceAll('__DURATION__', escapeHtml(fmtDuration(lic.duration_days)))
    .replaceAll('__DEVICES__', String(lic.max_devices))
    .replaceAll('__AMOUNT__', escapeHtml(fmtCents(lic.price_cents, env.CURRENCY || 'EUR')))
    .replaceAll('__VAT_NOTE__', escapeHtml(s.seller_vat_note || 'TVA non applicable, art. 293 B du CGI.'));
  return html(page);
}
