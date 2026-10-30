/*
 * Module de licence à intégrer dans vos applications (web, Electron, Capacitor, Tauri…).
 * Fonctionne sans aucune dépendance.
 *
 * Utilisation minimale :
 *
 *   1. Chargez ce fichier dans votre page avec une balise script (src="licence-client.js").
 *   2. Puis, dans votre code :
 *
 *     const licence = new LicenceClient({ serverUrl: 'https://licences.xxx.workers.dev', app: 'youpub' });
 *     licence.gate().then(() => {
 *       // ✅ licence valide : démarrez votre application ici
 *     });
 *
 * gate() affiche automatiquement une fenêtre (en français) demandant la clé si nécessaire,
 * puis ne rend la main que lorsque la licence est valide. L'application reste bloquée sinon.
 *
 * Mises à jour : passez { version: '1.2.0' } ; quand vous publiez une version plus récente dans l'administration,
 * le client voit « Nouvelle version disponible » avec le lien de téléchargement.
 *
 * Utilisation avancée : activate(key), check(), deactivate(), getInfo(), onChange(fn), notifyUpdate()
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LicenceClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHECK_INTERVAL_MS = 24 * 3600 * 1000; // revérification en ligne toutes les 24 h

  function LicenceClient(opts) {
    if (!opts || !opts.serverUrl) throw new Error('LicenceClient : serverUrl manquant');
    this.serverUrl = String(opts.serverUrl).replace(/\/+$/, '');
    this.app = opts.app || null;               // slug de l'application (vérifie que la clé est bien pour cette app)
    this.storageKey = opts.storageKey || ('licence:' + (this.app || 'app'));
    this.storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
    this.deviceName = opts.deviceName || defaultDeviceName();
    this.buyUrl = opts.buyUrl || (this.app ? this.serverUrl + '/buy/' + this.app : null);
    this.appName = opts.appName || 'cette application';
    this.version = opts.version || null;        // version actuelle de VOTRE application (ex : '1.2.0') pour signaler les mises à jour
    this.onUpdateAvailable = opts.onUpdateAvailable || null;
    this._listeners = [];
    this._state = this._load();
  }

  LicenceClient.prototype._load = function () {
    try { return JSON.parse(this.storage.getItem(this.storageKey) || 'null') || {}; } catch (e) { return {}; }
  };
  LicenceClient.prototype._save = function () {
    try { this.storage.setItem(this.storageKey, JSON.stringify(this._state)); } catch (e) {}
    var self = this; this._listeners.forEach(function (fn) { try { fn(self.getInfo()); } catch (e) {} });
  };
  LicenceClient.prototype.onChange = function (fn) { this._listeners.push(fn); };

  /** Identifiant unique et stable de cet appareil/navigateur. */
  LicenceClient.prototype.getDeviceId = function () {
    if (!this._state.deviceId) {
      var id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      this._state.deviceId = id; this._save();
    }
    return this._state.deviceId;
  };

  LicenceClient.prototype._post = async function (path, body) {
    var res = await fetch(this.serverUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    var data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) { var err = new Error((data && data.error) || ('Erreur ' + res.status)); err.code = data && data.code; err.status = res.status; throw err; }
    return data;
  };

  LicenceClient.prototype._store = function (r, key) {
    this._state.key = key || (r.license && r.license.key) || this._state.key;
    this._state.token = r.token;
    this._state.tokenExp = r.token_expires_at;
    this._state.license = r.license;
    this._state.lastCheck = Date.now();
    this._save();
  };

  /** Active une clé sur cet appareil. Lève une erreur (message en français) en cas de refus. */
  LicenceClient.prototype.activate = async function (key) {
    key = String(key || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    var r = await this._post('/api/activate', { key: key, device_id: this.getDeviceId(), device_name: this.deviceName, app: this.app });
    this._store(r, key);
    return this.getInfo();
  };

  /**
   * Vérifie la licence. Retourne { valid, reason, offline, info }.
   * - Si une vérification en ligne a eu lieu il y a moins de 24 h et que le jeton est valide : OK sans réseau.
   * - Sinon : interroge le serveur. Hors ligne, le jeton reste accepté jusqu'à sa date d'expiration (7 jours max).
   */
  LicenceClient.prototype.check = async function (force) {
    var s = this._state;
    if (!s.key && !s.token) return { valid: false, reason: 'NO_KEY', message: 'Aucune clé enregistrée.' };
    var tokenOk = s.tokenExp && new Date(s.tokenExp).getTime() > Date.now();
    var fresh = s.lastCheck && (Date.now() - s.lastCheck) < CHECK_INTERVAL_MS;
    if (tokenOk && fresh && !force) return { valid: true, info: this.getInfo() };
    try {
      var r = await this._post('/api/verify', { key: s.key, token: s.token, device_id: this.getDeviceId(), device_name: this.deviceName, app: this.app });
      this._store(r);
      return { valid: true, info: this.getInfo() };
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500) {
        // Refus définitif du serveur (expirée, révoquée, trop d'appareils…)
        this._state.license = null; this._state.token = null; this._state.tokenExp = null; this._save();
        return { valid: false, reason: e.code || 'REFUSED', message: e.message };
      }
      // Problème réseau : on tolère tant que le jeton n'est pas expiré
      if (tokenOk) return { valid: true, offline: true, info: this.getInfo() };
      return { valid: false, reason: 'OFFLINE', message: 'Connexion au serveur impossible. Reconnectez-vous à Internet pour vérifier la licence.' };
    }
  };

  /** Libère cet appareil (pour utiliser la clé ailleurs) et oublie la clé localement. */
  LicenceClient.prototype.deactivate = async function () {
    var s = this._state;
    if (s.key) { try { await this._post('/api/deactivate', { key: s.key, device_id: this.getDeviceId() }); } catch (e) {} }
    this._state = { deviceId: s.deviceId }; this._save();
  };

  LicenceClient.prototype.getInfo = function () {
    var s = this._state;
    if (!s.license) return null;
    var l = s.license;
    var daysLeft = l.expires_at ? Math.ceil((new Date(l.expires_at).getTime() - Date.now()) / 86400000) : null;
    return { key: s.key, product: l.product, productName: l.product_name, lifetime: !!l.lifetime, expiresAt: l.expires_at, daysLeft: daysLeft, maxDevices: l.max_devices, devicesUsed: l.devices_used, lastCheck: s.lastCheck,
      latestVersion: l.latest_version || null, downloadUrl: l.download_url || null, changelog: l.changelog || '',
      updateAvailable: !!(this.version && l.latest_version && l.latest_version !== this.version) };
  };

  /** Signale une nouvelle version (petite notification en bas de l'écran) si le vendeur en a publié une. */
  LicenceClient.prototype.notifyUpdate = function (info) {
    info = info || this.getInfo();
    if (!info || !info.updateAvailable) return false;
    if (this.onUpdateAvailable) { this.onUpdateAvailable(info); return true; }
    var self = this;
    if (typeof document === 'undefined') return true;
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:12px 16px;border-radius:12px;font-family:sans-serif;font-size:14px;z-index:2147483646;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;max-width:92vw';
    t.innerHTML = '<span>Nouvelle version ' + esc(info.latestVersion) + ' de ' + esc(self.appName) + ' disponible</span>' +
      (info.downloadUrl ? '<a href="' + esc(info.downloadUrl) + '" target="_blank" rel="noopener" style="color:#6ee7b7;font-weight:600;text-decoration:none">Télécharger</a>' : '') +
      '<button style="background:none;border:0;color:#94a3b8;font-size:18px;cursor:pointer;padding:0 2px">×</button>';
    t.querySelector('button').onclick = function () { t.remove(); };
    document.body.appendChild(t);
    return true;
  };

  /**
   * Bloque l'application tant que la licence n'est pas valide : affiche une fenêtre de saisie de clé.
   * Retourne une promesse résolue quand la licence est valide. Option : { onValid(info) }
   */
  LicenceClient.prototype.gate = async function (options) {
    options = options || {};
    var res = await this.check();
    if (res.valid) {
      if (res.info && !res.info.lifetime && res.info.daysLeft !== null && res.info.daysLeft <= 7 && options.warnExpiry !== false) {
        this._toast('Votre licence expire dans ' + res.info.daysLeft + ' jour' + (res.info.daysLeft > 1 ? 's' : '') + '.');
      }
      if (options.notifyUpdate !== false) this.notifyUpdate(res.info);
      return res.info;
    }
    return this._showDialog(res, options);
  };

  LicenceClient.prototype._showDialog = function (res, options) {
    var self = this;
    return new Promise(function (resolve) {
      if (typeof document === 'undefined') { resolve(null); return; }
      var old = document.getElementById('licence-gate'); if (old) old.remove();
      var wrap = document.createElement('div'); wrap.id = 'licence-gate';
      wrap.innerHTML =
        '<style>#licence-gate{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.92);display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a}' +
        '#licence-gate .box{background:#fff;border-radius:16px;padding:24px;width:min(420px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.4)}' +
        '#licence-gate h2{margin:0 0 6px;font-size:20px}#licence-gate p{margin:0 0 14px;color:#475569;font-size:14px;line-height:1.4}' +
        '#licence-gate input{width:100%;box-sizing:border-box;padding:12px;font-size:17px;font-family:ui-monospace,Menlo,Consolas,monospace;border:1px solid #cbd5e1;border-radius:10px;text-transform:uppercase;letter-spacing:1px}' +
        '#licence-gate button{width:100%;margin-top:10px;padding:12px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:#10b981;color:#052e16;cursor:pointer}#licence-gate button:disabled{opacity:.6}' +
        '#licence-gate .err{color:#dc2626;font-size:14px;margin-top:10px;min-height:18px}#licence-gate a{color:#2563eb;font-size:14px}#licence-gate .foot{margin-top:14px;text-align:center}</style>' +
        '<div class="box"><h2>🔑 Activation requise</h2><p>Entrez votre clé de licence pour utiliser ' + esc(self.appName) + '.</p>' +
        '<input id="lg-key" placeholder="XXXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">' +
        '<button id="lg-btn">Activer</button><div class="err" id="lg-err">' + (res.reason && res.reason !== 'NO_KEY' ? esc(res.message || '') : '') + '</div>' +
        (self.buyUrl ? '<div class="foot"><a href="' + esc(self.buyUrl) + '" target="_blank" rel="noopener">Acheter une licence ou retrouver ma clé</a></div>' : '') + '</div>';
      document.body.appendChild(wrap);
      var input = wrap.querySelector('#lg-key'), btn = wrap.querySelector('#lg-btn'), err = wrap.querySelector('#lg-err');
      if (self._state.key) input.value = self._state.key;
      setTimeout(function () { input.focus(); }, 50);
      async function submit() {
        err.textContent = ''; btn.disabled = true; btn.textContent = 'Vérification…';
        try {
          var info = await self.activate(input.value);
          wrap.remove();
          if (options.onValid) options.onValid(info);
          resolve(info);
        } catch (e) {
          err.textContent = e.message || 'Activation impossible';
          btn.disabled = false; btn.textContent = 'Activer';
        }
      }
      btn.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
  };

  LicenceClient.prototype._toast = function (msg) {
    if (typeof document === 'undefined') return;
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;font-family:sans-serif;font-size:14px;z-index:2147483646;box-shadow:0 8px 30px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 6000);
  };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function defaultDeviceName() {
    try {
      var ua = navigator.userAgent || '';
      var os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Linux/.test(ua) ? 'Linux' : 'Appareil';
      var br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
      return (os + ' ' + br).trim();
    } catch (e) { return 'Appareil'; }
  }
  function memoryStorage() { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; }

  return LicenceClient;
});
