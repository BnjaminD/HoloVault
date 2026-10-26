# ADR-001 — Choix de la stack technique

**Statut :** accepté — 2026-10-25

## Contexte

Boutique en ligne de cartes TCG (Pokémon, Yu-Gi-Oh!, Magic, One Piece, Lorcana) :
catalogue, comptes clients, commande sans compte (accès par référence + code de commande),
paiement PayPal, back-office. Exigence forte : **aucune faille de sécurité connue**.
Hébergement visé : VPS Hetzner (Node.js déjà utilisé pour d'autres projets).

## Options évaluées

| Critère                    | Next.js + Prisma + Postgres | PHP / Laravel        | **Express 5 + SQLite + EJS (SSR)** |
|----------------------------|-----------------------------|----------------------|------------------------------------|
| Surface d'attaque          | Large (RSC, server actions, bundle client) | Moyenne | **Faible : peu de dépendances, pas de JS front obligatoire** |
| Dépendances npm            | ~300+                       | n/a (composer ~100)  | **~10 directes**                   |
| Contrôle de la sécurité    | Implicite (framework)       | Bon (Laravel)        | **Explicite, auditable ligne à ligne** |
| Déploiement VPS existant   | Moyen (build, mémoire)      | Nouvelle stack       | **Immédiat (Node déjà en place)**  |
| SEO / performance          | Très bon                    | Bon                  | Très bon (HTML serveur)            |
| Intégration PayPal REST    | OK                          | OK                   | OK (fetch natif)                   |

## Décision

- **Runtime :** Node.js ≥ 20, ES modules.
- **Serveur :** Express 5 (gestion native des erreurs async).
- **Vues :** EJS rendu côté serveur, échappement HTML automatique (`<%= %>`).
- **Base :** SQLite (better-sqlite3) en WAL, requêtes **100 % paramétrées**, transactions pour le stock.
  Migration vers Postgres possible si le trafic l'exige.
- **Sécurité :** Helmet (CSP stricte avec nonce), sessions côté serveur, jetons CSRF + vérification d'Origin,
  scrypt (crypto natif) pour les mots de passe et codes de commande, rate-limiting, validation Zod,
  montants recalculés côté serveur, vérification de la capture et des webhooks PayPal.
- **Paiement :** API REST PayPal Orders v2 (création et capture côté serveur) + boutons JS SDK.
- **Tests :** `node:test` + supertest (fonctionnels et sécurité) et script de pentest automatisé.

## Conséquences

- Moins de « magie » de framework : chaque protection est visible et testée.
- SQLite impose une seule instance d'application (suffisant pour une boutique de niche).
