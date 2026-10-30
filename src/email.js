// Envoi d'emails via Brevo (gratuit : 300/jour) ou Resend (gratuit : 3 000/mois)

import { escapeHtml, fmtDuration, fmtDateFr } from './util.js';
import { logEvent } from './db.js';

export function emailProvider(env) {
  if (env.BREVO_API_KEY) return 'brevo';
  if (env.RESEND_API_KEY) return 'resend';
  return null;
}

export function emailConfigured(env) {
  return !!(emailProvider(env) && env.EMAIL_FROM);
}

/** Envoie un email. Retourne { ok, provider, error }. Ne lève jamais d'exception. */
export async function sendEmail(env, { to, subject, html, text }) {
  const provider = emailProvider(env);
  if (!provider || !env.EMAIL_FROM) return { ok: false, provider: null, error: 'Email non configuré' };
  const fromName = env.EMAIL_FROM_NAME || env.APP_NAME || 'Licences';
  try {
    let res;
    if (provider === 'brevo') {
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: env.EMAIL_FROM, name: fromName },
          to: [{ email: to }],
          subject, htmlContent: html, textContent: text,
        }),
      });
    } else {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${fromName} <${env.EMAIL_FROM}>`, to: [to], subject, html, text }),
      });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, provider, error: `${provider} ${res.status} : ${body.slice(0, 300)}` };
    }
    return { ok: true, provider };
  } catch (e) {
    return { ok: false, provider, error: String(e.message || e) };
  }
}

function layout(env, title, inner) {
  const brand = escapeHtml(env.APP_NAME || 'Vos licences');
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <p style="margin:0 0 6px;color:#6b7280;font-size:13px">${brand}</p>
    <h1 style="margin:0 0 18px;font-size:22px">${escapeHtml(title)}</h1>
    ${inner}
    <p style="margin:28px 0 0;color:#6b7280;font-size:12px">Conservez cet email : il contient votre clé d'accès.</p>
  </div></body></html>`;
}

function keyBlock(key) {
  return `<div style="margin:16px 0;padding:14px 16px;background:#0f172a;color:#fff;border-radius:10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;letter-spacing:1px;text-align:center">${escapeHtml(key)}</div>`;
}

/** Email envoyé après un achat ou une création manuelle. */
export async function sendLicenseEmail(env, { to, license, product, buyUrl }) {
  const durationTxt = license.duration_days > 0
    ? `Durée : <b>${fmtDuration(license.duration_days)}</b> à partir de la première activation.`
    : 'Durée : <b>illimitée</b>.';
  const dl = product.download_url
    ? `<p style="margin:12px 0"><a href="${escapeHtml(product.download_url)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Télécharger ${escapeHtml(product.name)}</a></p>`
    : '';
  const inner = `
    <p>Merci pour votre achat ! Voici votre clé d'accès pour <b>${escapeHtml(product.name)}</b>${license.offer_label ? ` (${escapeHtml(license.offer_label)})` : ''} :</p>
    ${keyBlock(license.key)}
    <p>${durationTxt}<br>Appareils autorisés : <b>${license.max_devices}</b>.</p>
    ${dl}
    <p><b>Comment l'utiliser :</b> ouvrez l'application, allez dans <i>Licence</i> (ou au premier démarrage), collez la clé et validez. L'application se débloque immédiatement.</p>
    ${buyUrl ? `<p style="color:#6b7280;font-size:13px">Clé perdue ? Rendez-vous sur <a href="${escapeHtml(buyUrl)}">${escapeHtml(buyUrl)}</a>, rubrique « Déjà acheté ? ».</p>` : ''}`;
  const text = `Votre clé pour ${product.name} : ${license.key}\n${license.duration_days > 0 ? 'Durée : ' + fmtDuration(license.duration_days) + ' à partir de la première activation.' : 'Durée illimitée.'}\nAppareils autorisés : ${license.max_devices}.\n${product.download_url ? 'Téléchargement : ' + product.download_url + '\n' : ''}Ouvrez l'application, rubrique Licence, collez la clé et validez.`;
  const r = await sendEmail(env, { to, subject: `Votre clé ${product.name}`, html: layout(env, `Votre clé ${product.name}`, inner), text });
  await logEvent(env, r.ok ? 'email_sent' : 'email_failed', license.id, r.ok ? `à ${to}` : `à ${to} : ${r.error}`);
  return r;
}

/** Email "clé perdue" : renvoie toutes les clés d'un client. */
export async function sendRecoveryEmail(env, { to, licenses }) {
  const items = licenses.map((l) => `
    <div style="margin:14px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px">
      <div><b>${escapeHtml(l.product_name)}</b>${l.offer_label ? ' · ' + escapeHtml(l.offer_label) : ''}</div>
      ${keyBlock(l.key)}
      <div style="color:#6b7280;font-size:13px">${l.state === 'revoked' ? 'Licence désactivée' : l.expires_at ? (l.state === 'expired' ? 'Expirée le ' : 'Valable jusqu\'au ') + fmtDateFr(l.expires_at) : l.duration_days > 0 ? 'Pas encore activée · ' + fmtDuration(l.duration_days) : 'Illimitée'}</div>
      ${l.product_download_url ? `<div style="margin-top:6px"><a href="${escapeHtml(l.product_download_url)}">Télécharger</a></div>` : ''}
    </div>`).join('');
  const inner = `<p>Vous avez demandé vos clés d'accès. Les voici :</p>${items}<p style="color:#6b7280;font-size:13px">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>`;
  const text = licenses.map((l) => `${l.product_name} : ${l.key}`).join('\n');
  return sendEmail(env, { to, subject: 'Vos clés d\'accès', html: layout(env, 'Vos clés d\'accès', inner), text });
}

/** Email au client après une commande à payer « à la main » : consignes + référence + lien de suivi. */
export async function sendOrderInstructionsEmail(env, { to, order, product, statusUrl, methodLabel }) {
  const inner = `
    <p>Merci pour votre commande de <b>${escapeHtml(product.name)}</b>${order.offer_label ? ` (${escapeHtml(order.offer_label)})` : ''}.</p>
    <div style="margin:14px 0;padding:14px;border:1px solid #e5e7eb;border-radius:10px">
      <div>Montant : <b>${escapeHtml((order.amount_cents / 100).toFixed(2).replace('.', ','))} ${escapeHtml(env.CURRENCY || 'EUR')}</b></div>
      <div>Mode de paiement : <b>${escapeHtml(methodLabel)}</b></div>
      <div>Référence à indiquer : <b>${escapeHtml(order.ref)}</b></div>
    </div>
    <p><b>Comment payer :</b><br>${escapeHtml(order.instructions || '').replace(/\n/g, '<br>')}</p>
    <p>Dès que le vendeur confirme la réception du paiement, votre clé d'accès vous est envoyée par email et apparaît sur votre page de suivi :</p>
    <p><a href="${escapeHtml(statusUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Suivre ma commande</a></p>`;
  const text = `Commande ${order.ref} – ${product.name}\nMontant : ${(order.amount_cents / 100).toFixed(2)} ${env.CURRENCY || 'EUR'} par ${methodLabel}\nRéférence à indiquer : ${order.ref}\n\nComment payer :\n${order.instructions || ''}\n\nSuivi : ${statusUrl}`;
  return sendEmail(env, { to, subject: `Votre commande ${order.ref} – ${product.name}`, html: layout(env, `Commande ${order.ref}`, inner), text });
}

/** Email au vendeur : une commande attend sa validation. */
export async function sendSellerOrderNotification(env, { to, order, product, methodLabel, adminUrl }) {
  const inner = `
    <p>Nouvelle commande à valider :</p>
    <div style="margin:14px 0;padding:14px;border:1px solid #e5e7eb;border-radius:10px">
      <div><b>${escapeHtml(product.name)}</b>${order.offer_label ? ' · ' + escapeHtml(order.offer_label) : ''}</div>
      <div>${escapeHtml((order.amount_cents / 100).toFixed(2).replace('.', ','))} ${escapeHtml(env.CURRENCY || 'EUR')} par <b>${escapeHtml(methodLabel)}</b></div>
      <div>Client : ${escapeHtml(order.name || '')} ${escapeHtml(order.email || '')}</div>
      <div>Référence : <b>${escapeHtml(order.ref)}</b></div>
    </div>
    <p>Quand le paiement est arrivé, ouvrez l'application et appuyez sur « Payé » : la clé part automatiquement.</p>
    <p><a href="${escapeHtml(adminUrl)}" style="display:inline-block;background:#10b981;color:#052e16;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Ouvrir l'application</a></p>`;
  const text = `Nouvelle commande à valider : ${order.ref} – ${product.name} ${order.offer_label || ''} – ${(order.amount_cents / 100).toFixed(2)} ${env.CURRENCY || 'EUR'} par ${methodLabel} – ${order.email}\n${adminUrl}`;
  return sendEmail(env, { to, subject: `À valider : ${order.ref} – ${product.name}`, html: layout(env, 'Commande à valider', inner), text });
}
