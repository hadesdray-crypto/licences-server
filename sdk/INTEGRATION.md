# Intégrer la licence dans une application (Youpub ou autre)

Le principe est toujours le même, quel que soit le langage :

1. Au démarrage, l'application regarde si une clé est enregistrée localement.
2. Si non → elle demande la clé au client et appelle `POST /api/activate`.
3. Si oui → elle appelle `POST /api/verify` au plus une fois par 24 h (le reste du temps, elle fait confiance au jeton reçu, valable 7 jours même hors ligne).
4. Si le serveur refuse (expirée, désactivée, trop d'appareils) → l'application se bloque et réaffiche la demande de clé.

Deux modules prêts à l'emploi sont fournis. **Envoyez-moi le code de Youpub et je fais l'intégration pour vous.**

## Application web / Electron / Capacitor / Tauri (JavaScript)

```html
<script src="licence-client.js"></script>
<script>
  const licence = new LicenceClient({
    serverUrl: 'https://licences.VOTRE-SOUS-DOMAINE.workers.dev',
    app: 'youpub',          // identifiant de l'application dans l'administration
    appName: 'Youpub',      // affiché dans la fenêtre d'activation
    version: '1.0.0',       // version de VOTRE application : si vous publiez une version plus récente dans l'administration,
                            // le client voit « Nouvelle version disponible » avec le lien de téléchargement
  });

  licence.gate().then((info) => {
    // ✅ Licence valide : lancez votre application ici
    console.log('Licence OK jusqu\'au', info.expiresAt);
  });
</script>
```

`gate()` affiche une fenêtre « Activation requise » en français, avec un lien « Acheter une licence ou retrouver ma clé » vers votre page de vente. Tant que la clé n'est pas valide, l'application reste masquée.

Fonctions utiles :

| Fonction | Rôle |
|---|---|
| `licence.gate()` | Bloque jusqu'à ce qu'une licence soit valide (affiche la fenêtre si besoin) |
| `licence.check()` | Vérifie sans rien afficher → `{ valid, reason, message, info }` |
| `licence.activate(cle)` | Active une clé saisie par vos soins |
| `licence.deactivate()` | Libère cet appareil (menu « Utiliser ma clé sur un autre ordinateur ») |
| `licence.getInfo()` | `{ productName, expiresAt, daysLeft, lifetime, maxDevices, devicesUsed, latestVersion, downloadUrl, updateAvailable }` pour afficher « Licence valable jusqu'au… » |
| `licence.notifyUpdate()` | Affiche la notification « Nouvelle version » (appelée automatiquement par `gate()`) |

## Application Python

```python
from licence_client import LicenceClient

licence = LicenceClient("https://licences.VOTRE-SOUS-DOMAINE.workers.dev", app="youpub", app_name="Youpub", version="1.0.0")
licence.gate()   # console : demande la clé si besoin
# ✅ démarrez l'application
```

Pour une interface graphique (Tkinter, PyQt), utilisez `licence.check()` puis `licence.activate(cle)` et affichez votre propre boîte de dialogue.

## Autre langage (C#, Java, Swift, Kotlin, Go…)

L'API est de simples requêtes HTTP JSON. Demandez-moi le module pour votre langage, ou implémentez :

### `POST /api/activate` (identique à `/api/verify`)

Corps :
```json
{ "key": "YOUPUB-AB12-CD34-EF56-GH78", "device_id": "identifiant-unique-stable", "device_name": "PC de Marc", "app": "youpub" }
```
`device_id` : un identifiant aléatoire généré une fois et conservé sur l'appareil (fichier de config). Il sert à compter les appareils.

Réponse `200` :
```json
{
  "ok": true,
  "token": "eyJsaWQiOjEsImRldiI6Ii4uLiJ9.signature",
  "token_expires_at": "2026-11-06T14:00:00.000Z",
  "license": { "key": "…", "product": "youpub", "product_name": "Youpub", "lifetime": false,
               "expires_at": "2027-10-30T14:00:00.000Z", "days_left": 365, "max_devices": 2, "devices_used": 1,
               "download_url": "https://…", "latest_version": "1.2.0", "changelog": "…" }
}
```

Erreurs (`4xx`, corps `{ "error": "message en français", "code": "…" }`) :

| code | signification |
|---|---|
| `UNKNOWN_KEY` | clé inconnue |
| `WRONG_APP` | clé d'une autre application |
| `EXPIRED` | licence expirée |
| `REVOKED` | licence désactivée par le vendeur |
| `DEVICE_LIMIT` | trop d'appareils |
| `PRODUCT_DISABLED` | application retirée de la vente |

Règle côté application : **une erreur `4xx` bloque l'application** ; une erreur réseau (pas de réponse) laisse passer tant que `token_expires_at` n'est pas dépassé.

### `POST /api/deactivate`
`{ "key": "…", "device_id": "…" }` → libère l'appareil.

### `POST /api/lookup`
`{ "key": "…" }` → état de la licence, lien de téléchargement, version (utilisé par la page `/go` « J'ai un code »).

### `POST /api/recover`
`{ "email": "client@exemple.fr" }` → renvoie ses clés par email (utilisé par la page de vente, rubrique « Déjà acheté ? »).

## Niveau de protection

- Le code de l'application reste sur l'ordinateur du client : un expert très motivé peut toujours modifier le programme pour sauter la vérification. Le système bloque efficacement le partage de clés (limite d'appareils) et la copie « normale », ce qui couvre la quasi-totalité des cas.
- Pour une protection totale, la partie précieuse de l'application doit tourner sur le serveur (version web). Nous pourrons en parler pour Youpub.
