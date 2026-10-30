-- Schéma de la base de données du serveur de licences (Cloudflare D1 / SQLite)
-- Toutes les dates sont au format ISO 8601 UTC (ex : 2026-10-30T14:49:12.345Z)

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,              -- identifiant dans l'URL (ex : youpub)
  name          TEXT NOT NULL,                     -- nom affiché (ex : Youpub)
  description   TEXT NOT NULL DEFAULT '',
  download_url  TEXT NOT NULL DEFAULT '',          -- lien de téléchargement envoyé après paiement
  key_prefix    TEXT NOT NULL,                     -- préfixe des clés (ex : YOUPUB)
  max_devices   INTEGER NOT NULL DEFAULT 2,        -- appareils autorisés par défaut
  version       TEXT NOT NULL DEFAULT '',          -- dernière version disponible (ex : 1.2.0), annoncée aux clients
  changelog     TEXT NOT NULL DEFAULT '',          -- nouveautés de cette version
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS offers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,                     -- ex : "1 an"
  days          INTEGER NOT NULL,                  -- durée en jours, 0 = à vie
  price_cents   INTEGER NOT NULL,                  -- prix en centimes (1999 = 19,99 €)
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS licenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT UNIQUE NOT NULL,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  customer_id     INTEGER REFERENCES customers(id),
  offer_label     TEXT NOT NULL DEFAULT '',
  duration_days   INTEGER NOT NULL,                -- 0 = à vie
  max_devices     INTEGER NOT NULL DEFAULT 2,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'manual',  -- manual | paypal | stripe | stock (clé en réserve, pas encore vendue)
  payment_method  TEXT NOT NULL DEFAULT '',        -- paypal | stripe | virement | lydia | wero | paypalme | revolut | cash | autre
  paypal_order_id TEXT UNIQUE,
  stripe_session_id TEXT,                          -- identifiant Stripe Checkout (index unique ci-dessous)
  stripe_payment_intent TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  activated_at    TEXT,                            -- première activation (le compte à rebours démarre ici)
  expires_at      TEXT,                            -- NULL = pas encore activée, ou à vie
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_product  ON licenses(product_id);
CREATE INDEX IF NOT EXISTS idx_licenses_created  ON licenses(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_stripe ON licenses(stripe_session_id);

CREATE TABLE IF NOT EXISTS devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id    INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  device_name   TEXT NOT NULL DEFAULT '',
  first_seen    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(license_id, device_id)
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,                     -- sale | license_created | activate | device_added | revoke | refund | ...
  license_id    INTEGER,
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS stats_daily (
  day           TEXT PRIMARY KEY,                  -- AAAA-MM-JJ
  requests      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS paypal_orders (
  order_id      TEXT PRIMARY KEY,
  product_id    INTEGER NOT NULL,
  offer_id      INTEGER,
  email         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'created',   -- created | completed
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT NOT NULL,                     -- ex : login:1.2.3.4
  window        TEXT NOT NULL,                     -- ex : 2026-10-30T14 (heure)
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window)
);

-- Réglages modifiables depuis l'application (PayPal, email, vendeur, mot de passe...)
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Commandes payées « à la main » (virement, Lydia, Wero, espèces…) : le vendeur valide le paiement dans l'application
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT UNIQUE NOT NULL,              -- référence courte donnée au client (ex : CMD-7K2P9X)
  token         TEXT NOT NULL,                     -- secret permettant au client de suivre sa commande
  product_id    INTEGER NOT NULL REFERENCES products(id),
  offer_id      INTEGER,
  offer_label   TEXT NOT NULL DEFAULT '',
  duration_days INTEGER NOT NULL DEFAULT 365,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  method        TEXT NOT NULL DEFAULT '',          -- virement | lydia | wero | paypalme | revolut | cash | autre
  email         TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | cancelled
  license_id    INTEGER,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
