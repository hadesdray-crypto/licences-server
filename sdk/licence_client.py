"""
Module de licence pour une application Python (Tkinter, PyQt, console…).
Aucune dépendance : utilise uniquement la bibliothèque standard.

Utilisation minimale :

    from licence_client import LicenceClient

    licence = LicenceClient("https://licences.xxx.workers.dev", app="youpub", app_name="Youpub")
    licence.gate()          # demande la clé si besoin (console), quitte si refusée
    # ✅ licence valide : démarrez votre application ici

Ou, pour une interface graphique, utilisez check() / activate() et affichez vous-même la fenêtre.
"""
import json
import os
import sys
import time
import uuid
import platform
import urllib.request
import urllib.error

CHECK_INTERVAL = 24 * 3600  # revérification en ligne toutes les 24 h


class LicenceError(Exception):
    def __init__(self, message, code=None, status=None):
        super().__init__(message)
        self.code = code
        self.status = status


class LicenceClient:
    def __init__(self, server_url, app=None, app_name="cette application", storage_path=None, device_name=None, version=None):
        self.server_url = server_url.rstrip("/")
        self.version = version  # version actuelle de votre application, pour signaler les mises à jour
        self.app = app
        self.app_name = app_name
        self.buy_url = f"{self.server_url}/buy/{app}" if app else None
        self.device_name = device_name or f"{platform.system()} {platform.node()}".strip()
        self.storage_path = storage_path or self._default_storage_path()
        self._state = self._load()

    # ----- stockage local -----
    def _default_storage_path(self):
        base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
        folder = os.path.join(base, f"licence-{self.app or 'app'}")
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, "licence.json")

    def _load(self):
        try:
            with open(self.storage_path, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except Exception:
            return {}

    def _save(self):
        try:
            with open(self.storage_path, "w", encoding="utf-8") as f:
                json.dump(self._state, f)
        except Exception:
            pass

    def device_id(self):
        if not self._state.get("device_id"):
            self._state["device_id"] = str(uuid.uuid4())
            self._save()
        return self._state["device_id"]

    # ----- réseau -----
    def _post(self, path, body):
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.server_url + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
            except Exception:
                payload = {}
            raise LicenceError(payload.get("error", f"Erreur {e.code}"), payload.get("code"), e.code)
        except Exception as e:  # réseau coupé, DNS, timeout…
            raise LicenceError(f"Connexion impossible : {e}", "OFFLINE", None)

    def _store(self, r, key=None):
        self._state["key"] = key or (r.get("license") or {}).get("key") or self._state.get("key")
        self._state["token"] = r.get("token")
        self._state["token_exp"] = r.get("token_expires_at")
        self._state["license"] = r.get("license")
        self._state["last_check"] = time.time()
        self._save()

    # ----- API publique -----
    def activate(self, key):
        """Active une clé sur cet appareil. Lève LicenceError en cas de refus."""
        key = "".join(c for c in key.upper() if c.isalnum() or c == "-")
        r = self._post("/api/activate", {"key": key, "device_id": self.device_id(), "device_name": self.device_name, "app": self.app})
        self._store(r, key)
        return self.info()

    def check(self, force=False):
        """Retourne (valide: bool, message: str). Tolère 7 jours hors ligne."""
        s = self._state
        if not s.get("key") and not s.get("token"):
            return False, "Aucune clé enregistrée."
        token_ok = bool(s.get("token_exp")) and _parse_iso(s["token_exp"]) > time.time()
        fresh = s.get("last_check") and (time.time() - s["last_check"]) < CHECK_INTERVAL
        if token_ok and fresh and not force:
            return True, "OK"
        try:
            r = self._post("/api/verify", {"key": s.get("key"), "token": s.get("token"), "device_id": self.device_id(), "device_name": self.device_name, "app": self.app})
            self._store(r)
            return True, "OK"
        except LicenceError as e:
            if e.status and 400 <= e.status < 500:
                s["license"] = None; s["token"] = None; s["token_exp"] = None
                self._save()
                return False, str(e)
            if token_ok:
                return True, "Hors ligne (jeton encore valide)"
            return False, "Connexion au serveur impossible. Reconnectez-vous à Internet pour vérifier la licence."

    def deactivate(self):
        """Libère cet appareil pour utiliser la clé ailleurs."""
        if self._state.get("key"):
            try:
                self._post("/api/deactivate", {"key": self._state["key"], "device_id": self.device_id()})
            except LicenceError:
                pass
        self._state = {"device_id": self._state.get("device_id")}
        self._save()

    def info(self):
        lic = self._state.get("license")
        if not lic:
            return None
        days_left = None
        if lic.get("expires_at"):
            days_left = int((_parse_iso(lic["expires_at"]) - time.time()) // 86400) + 1
        latest = lic.get("latest_version") or None
        return {"key": self._state.get("key"), "product": lic.get("product"), "product_name": lic.get("product_name"), "lifetime": lic.get("lifetime"), "expires_at": lic.get("expires_at"), "days_left": days_left, "max_devices": lic.get("max_devices"), "devices_used": lic.get("devices_used"),
                "latest_version": latest, "download_url": lic.get("download_url") or None, "changelog": lic.get("changelog") or "",
                "update_available": bool(self.version and latest and latest != self.version)}

    def gate(self, max_tries=5):
        """Mode console : demande la clé tant qu'elle n'est pas valide ; quitte le programme en cas d'échec."""
        valid, msg = self.check()
        if valid:
            inf = self.info()
            if inf and inf.get("days_left") is not None and inf["days_left"] <= 7:
                print(f"⚠️  Votre licence expire dans {inf['days_left']} jour(s).")
            if inf and inf.get("update_available"):
                print(f"⬆️  Nouvelle version {inf['latest_version']} disponible : {inf.get('download_url') or ''}")
            return inf
        print(f"🔑 Activation requise pour {self.app_name}.")
        if msg and msg != "Aucune clé enregistrée.":
            print(f"   {msg}")
        if self.buy_url:
            print(f"   Acheter une licence / retrouver ma clé : {self.buy_url}")
        for _ in range(max_tries):
            key = input("Clé de licence : ").strip()
            if not key:
                continue
            try:
                inf = self.activate(key)
                print(f"✅ Licence activée ({'à vie' if inf['lifetime'] else 'jusqu\'au ' + inf['expires_at'][:10]}).")
                return inf
            except LicenceError as e:
                print(f"❌ {e}")
        print("Trop de tentatives.")
        sys.exit(1)


def _parse_iso(s):
    from datetime import datetime, timezone
    s = s.replace("Z", "+00:00")
    return datetime.fromisoformat(s).astimezone(timezone.utc).timestamp()


if __name__ == "__main__":
    # Test rapide :  python licence_client.py https://votre-serveur.workers.dev youpub
    url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
    slug = sys.argv[2] if len(sys.argv) > 2 else None
    c = LicenceClient(url, app=slug, app_name=slug or "test")
    print(c.gate())
