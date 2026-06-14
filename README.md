# job-agregator

Agrégateur de jobboards **maison**, **déterministe** et **auditable**, doublé d'une
**UI web locale** (mono-utilisateur, `localhost`). Il récupère **toutes** les offres
à partir de **termes choisis à la main**, applique **son propre filtrage
déterministe**, et **expose le résultat dans une UI web** (consultation, favoris,
suppression, stats, déclenchement de run).

Objectif : remplacer les alertes natives (peu fiables) et les filtres faibles des
jobboards par un système maison, sans LLM, lisible en `git diff` et couvert par des
tests.

```
settings (sqlite) → fetch concurrent [1 tâche/source, tous les termes]
                  → dedup (sqlite) → filtre déterministe → base sqlite ← UI web locale
```

> Fork allégé de `Job_watcher` — voir `CLAUDE.md` pour les conventions complètes.
> Pas de LLM, pas de Notion, pas d'onboarding/profil : volontairement déterministe.

## Stack

- **Pipeline** : Node + TypeScript + `better-sqlite3`.
- **UI locale** : Fastify (API REST + SSE) + Vite/React + Tailwind CSS v4, liée à
  `127.0.0.1` uniquement.
- **Scraping** : Playwright (+ stealth) pour les sources web ; API JSON pour les
  sources ATS.

## Installation

```bash
npm install          # deps + binaire Chromium (Playwright, via postinstall)
cp .env.example .env # toutes les variables sont OPTIONNELLES (voir le fichier)
```

## Lancer l'UI web

```bash
npm run build        # build le SPA dans web/dist
npm run serve        # sert l'UI sur http://127.0.0.1:5627 (surchargeable par PORT)
```

`npm run start` (= `build` + `serve`) reste pratique pour un lancement manuel
one-shot. Après tout changement de code **frontend**, relancer `npm run build` pour
rafraîchir `web/dist`.

L'UI a **3 pages** : **Paramètres** (termes, types de contrat, sources actives,
boards ATS), **Stats** et **Offres** (consultation, favoris, suppression,
déclenchement de run).

## Lancer un run en CLI

Un run du pipeline est aussi lançable hors UI :

```bash
npm run fetch        # run réel → écrit en base sqlite
npm run fetch:dry    # dry-run → log seulement, n'écrit pas
```

Depuis l'UI, le run est déclenché via `POST /api/run` : le serveur spawn le pipeline
et relaie sa progression en **SSE** (`GET /api/run/stream`). Un verrou serveur
garantit **un seul run à la fois**.

## Configuration

La config **effective** vit dans la table sqlite `settings`, seedée une première
fois depuis `config/search.config.ts`. L'UI Paramètres pilote les champs dynamiques
(`terms[]`, `contractTypes`, `enabledSources[]`, `atsBoards`). Les critères statiques
(`exclude`, `salaryMin`, `locations`…) restent dans `config/search.config.ts`
(édition = `git diff`) :

```ts
export const config: SearchConfig = {
  terms: ["data engineer", "machine learning engineer"],
  exclude: ["stage", "stagiaire", "alternance"],
  salaryMin: 45000,
  locations: ["Paris", "remote"],
  contractTypes: ["CDI"],
  // …
};
```

Le filtrage vit entièrement dans `src/filter.ts` sous forme de **fonctions pures**
`(offer, config) => boolean` — aucun I/O, aucun réseau, aucun LLM.

## Sources

- **Web** (Playwright) : WTTJ (session requise, ci-dessous), HelloWork.
- **ATS** (API JSON par board d'entreprise) : Greenhouse, Lever — les tokens
  d'entreprise se gèrent depuis l'UI Paramètres (`settings.atsBoards`).

Chaque source implémente l'interface `ScrapingSource` et est **best-effort** : une
source qui échoue/expire logge l'erreur et renvoie `[]` sans casser le run.
L'orchestrateur lance **une tâche par source** (concurrence bornée + timeout) et la
source boucle **tous les termes en interne** (un seul navigateur par hôte, sûr
anti-bot).

### WTTJ : session requise (connexion unique)

Welcome to the Jungle a placé sa recherche par mot-clé derrière l'authentification.
La source rejoue une **session Playwright** exportée **une seule fois** :

```bash
npm run wttj:login   # ouvre une fenêtre WTTJ → connecte-toi → reviens, Entrée
```

Tu te connectes **toi-même** dans la fenêtre (aucun mot de passe ne transite par le
code). La session est écrite dans `data/wttj-session.json` (gitignored ; surchargeable
via `WTTJ_STORAGE_STATE`). Sans session, WTTJ est best-effort (WARN + `[]`).
Pré-requis : un environnement **graphique** (navigateur visible).

## Tests & qualité

```bash
npm test             # node:test via tsx (glob src/**/*.test.ts), zéro dép de test
npm run typecheck    # vérification TypeScript (pipeline + serveur)
npm run typecheck:web
```

Toute logique pure (filtre, mappers de sources, helpers) est couverte. Un test
d'intégration exerce `runPipeline` sur une base sqlite **temporaire isolée**
(jamais la vraie base). La base `data/job-agregator.db` est locale et
reconstructible (gitignored).

## Autostart (service systemd `--user`)

```bash
npm run autostart:install   # écrit ~/.config/systemd/user/job-agregator.service,
                            # build le SPA une fois, active le linger, démarre
```

`ExecStart=npm run serve` ne rebuild pas : après un changement frontend, relancer
`npm run build` (ou `npm run autostart:install`) pour rafraîchir `web/dist`.

## Architecture

Voir `CLAUDE.md` pour le détail des conventions (orchestration concurrente, dédup
par hash composite, observabilité, design system UI, contrat d'API figé dans
`docs/api-contract.md`).
