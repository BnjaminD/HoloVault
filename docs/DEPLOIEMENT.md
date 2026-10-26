# Déploiement et exploitation

Cible : un VPS Linux (Hetzner) avec Node.js 22+, Nginx ou Caddy en reverse proxy (TLS), systemd.

## 1. Installation initiale du serveur

```bash
# Utilisateur dédié, propriétaire du code et des données
sudo useradd --system --create-home --home-dir /srv/holovault --shell /bin/bash holovault
sudo -iu holovault
git clone https://github.com/BnjaminD/HoloVault.git /srv/holovault   # dépôt privé : utiliser une deploy key
cd /srv/holovault
cp .env.example .env && chmod 600 .env   # puis remplir (NODE_ENV=production, SESSION_SECRET, PayPal…)
npm ci --omit=dev
npm run migrate
npm run create-admin -- vous@domaine.fr
exit

# Services systemd (fichiers dans docs/deploy/)
sudo cp /srv/holovault/docs/deploy/holovault*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now holovault holovault-backup.timer
curl -fsS http://127.0.0.1:3000/healthz
```

L'utilisateur `holovault` doit pouvoir redémarrer le service, et seulement cela (`sudo visudo -f /etc/sudoers.d/holovault`) :

```
holovault ALL=(root) NOPASSWD: /usr/bin/systemctl restart holovault
```

## 2. Déploiement continu (GitHub Actions)

`.github/workflows/deploy.yml` déploie `main` dès que la CI est verte, ou à la demande (onglet Actions → Deploy → Run workflow).

Le script [`scripts/deploy.sh`](../scripts/deploy.sh) exécuté sur le serveur :

1. récupère la révision (`git fetch` + `checkout`) ;
2. sauvegarde la base ;
3. `npm ci --omit=dev`, puis migrations ;
4. redémarre le service et attend `/healthz` ;
5. **en cas d'échec, revient automatiquement à la révision précédente.**

### Configuration GitHub (Settings → Secrets and variables → Actions)

| Type | Nom | Valeur |
|---|---|---|
| Variable | `DEPLOY_ENABLED` | `true` pour activer le déploiement |
| Variable | `PRODUCTION_URL` | `https://votre-domaine.fr` (smoke test public, optionnel) |
| Secret | `DEPLOY_HOST` | IP ou nom du VPS |
| Secret | `DEPLOY_USER` | `holovault` |
| Secret | `DEPLOY_PATH` | `/srv/holovault` |
| Secret | `DEPLOY_SSH_KEY` | clé privée ed25519 dédiée (sa clé publique dans `~holovault/.ssh/authorized_keys`) |
| Secret | `DEPLOY_KNOWN_HOSTS` | sortie de `ssh-keyscan -t ed25519 <host>` |

Dans Settings → Environments → `production`, ajouter un *required reviewer* pour valider chaque mise en production à la main.

## 3. Migrations de schéma

- `src/db/schema.sql` est le schéma de base (version 0) ; ne plus le modifier.
- Chaque évolution est un fichier `src/db/migrations/NNN-description.sql`, appliqué une seule fois, dans l'ordre,
  dans une transaction ; la version courante est stockée dans `PRAGMA user_version`.
- Les migrations sont appliquées au démarrage et par `npm run migrate`.
- **Règle :** uniquement des changements compatibles avec la version précédente du code (ajout de table, de colonne
  nullable ou avec valeur par défaut, d'index). Pas de `DROP` ni de renommage dans le même déploiement : le rollback
  automatique remet l'ancien code sur la base déjà migrée.

## 4. Sauvegardes

- `npm run backup` : copie à chaud cohérente (API de sauvegarde SQLite), vérifiée par `integrity_check`, rotation
  des `BACKUP_KEEP` dernières (14 par défaut) dans `BACKUP_DIR` (`data/backups` par défaut).
- Lancée chaque nuit par `holovault-backup.timer` et avant chaque déploiement.
- **Hors serveur :** décommenter les lignes `rclone` de `holovault-backup.service` (Backblaze B2, S3, etc.) pour copier
  aussi les images produits (`data/uploads`). Une sauvegarde qui reste sur le VPS ne protège pas d'une perte du VPS.

### Restauration

```bash
cd /srv/holovault
sudo systemctl stop holovault
sudo -u holovault cp data/backups/shop-AAAAMMJJ-HHMMSS.db data/shop.db
sudo -u holovault rm -f data/shop.db-wal data/shop.db-shm
sudo systemctl start holovault
```

## 5. Supervision

- `GET /healthz` → `{"status":"ok"}` (200) ou 503 si la base est inaccessible. À brancher sur un moniteur externe
  (UptimeRobot, Better Stack…).
- Journaux : `journalctl -u holovault -f`.
