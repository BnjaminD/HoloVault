# HoloVault

[![CI](https://github.com/BnjaminD/HoloVault/actions/workflows/ci.yml/badge.svg)](https://github.com/BnjaminD/HoloVault/actions/workflows/ci.yml)

Boutique en ligne de cartes TCG (Pokémon, Yu-Gi-Oh!, Magic, One Piece, Lorcana) — Express 5, EJS, SQLite, PayPal.
Choix techniques : [docs/ADR-001-stack.md](docs/ADR-001-stack.md).

## Démarrage local

```bash
cp .env.example .env      # puis NODE_ENV=development et PAYPAL_MODE=mock
npm ci
npm run seed              # catalogue de démo
npm run create-admin      # compte back-office
npm run dev               # http://localhost:3000
```

## Qualité et sécurité

| Commande | Rôle |
|---|---|
| `npm run lint` | ESLint |
| `npm test` / `npm run test:coverage` | Tests fonctionnels et sécurité (`node:test` + supertest) |
| `npm run pentest` | Contrôles boîte noire contre une instance démarrée (`PENTEST_URL`) |
| `npm run audit` | Vulnérabilités des dépendances de production |

La CI GitHub Actions (`.github/workflows/ci.yml`) exécute lint, tests (Node 22 et 24), audit, pentest sur une
instance éphémère et détection de secrets (gitleaks) à chaque push et pull request. CodeQL tourne en plus chaque semaine.

## Exploitation

- `GET /healthz` : état de l'application et de la base (monitoring, smoke test de déploiement).
