#!/usr/bin/env bash
# Déploie une révision sur le serveur : sauvegarde → code → dépendances → migrations → redémarrage → healthcheck.
# En cas d'échec, revient automatiquement à la révision précédente.
# Lancé par .github/workflows/deploy.yml :  ssh user@vps "bash -s -- <sha> <dossier>" < scripts/deploy.sh
set -euo pipefail

REF="${1:?Usage : deploy.sh <révision> [dossier]}"
APP_DIR="${2:-$PWD}"
SERVICE="${HOLOVAULT_SERVICE:-holovault}"

cd "$APP_DIR"
PORT="$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1)"
PORT="${PORT:-3000}"
PREV="$(git rev-parse HEAD)"

step() { printf '\n→ %s\n' "$*"; }

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

rollback() {
  printf '\n✖ Échec du déploiement de %s, retour à %s\n' "$REF" "$PREV" >&2
  git checkout --quiet --detach "$PREV"
  npm ci --omit=dev --no-audit --no-fund
  sudo systemctl restart "$SERVICE"
  healthy && echo "Version précédente rétablie." >&2 || echo "ATTENTION : la version précédente ne répond pas non plus." >&2
  exit 1
}

step "Sauvegarde de la base"
BACKUP_ALLOW_MISSING=1 npm run -s backup

step "Récupération de ${REF}"
git fetch --quiet --tags origin
git checkout --quiet --detach "$REF"

trap rollback ERR
step "Dépendances"
npm ci --omit=dev --no-audit --no-fund

step "Migrations"
npm run -s migrate

step "Redémarrage de ${SERVICE}"
sudo systemctl restart "$SERVICE"

step "Vérification /healthz"
healthy || rollback
trap - ERR
printf '\n✔ %s déployé (%s)\n' "$(git rev-parse --short HEAD)" "$(date -Iseconds)"
