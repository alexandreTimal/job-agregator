# CLAUDE.md — Guide de collaboration agent ↔ repo

Ce fichier documente les conventions que tout agent (Claude Code, Copilot, etc.)
doit respecter avant de modifier le projet. Les règles ici priment sur les
habitudes par défaut de l'agent.

## Nature du projet

`job-agregator` est un **fork allégé** de `Job_watcher`. C'est un **agrégateur
de jobboards maison**, déterministe, doublé d'une **UI web locale** (mono-utilisateur,
`localhost`) qui a **remplacé Notion** :

```
settings (sqlite) → [par terme × par source] fetch → dedup (sqlite) → filtre déterministe → base sqlite ← UI web locale
```

Objectif : remplacer les alertes natives (peu fiables) et les filtres faibles
des jobboards par un système maison qui fetch **toutes** les offres à partir de
**termes choisis à la main**, applique **notre propre filtrage**, et **expose le
résultat dans une UI web locale** (consultation, favoris, suppression, stats,
déclenchement de run).

### Différences assumées avec le repo d'origine `Job_watcher`

- **Pas de LLM.** Aucun appel à un modèle, aucun prompt. Le repo d'origine est un
  banc d'essai LLM ; ce fork est volontairement déterministe et auditable.
- **UI web LOCALE assumée.** Une petite app **Fastify + Vite/React** liée à
  `127.0.0.1` (mono-utilisateur) remplace Notion. La clause historique « pas de
  web app / React » est **levée pour ce périmètre précis** : pas de Next.js,
  pas de tRPC, pas de Supabase, pas d'auth — juste un serveur Fastify local qui
  sert l'API REST + le build Vite.
- **Pas d'onboarding / profil.** Pas de CV, d'analyse d'intention, de branches,
  ni de génération de titres.
- **Stack :** Node + TypeScript + `better-sqlite3` (pipeline) ; Fastify +
  Vite/React (UI locale).

> Ce projet vit dans un dossier **séparé**. On ne modifie **jamais** le code du
> repo `Job_watcher` voisin ; on en copie/cherry-pick des fichiers (sources,
> dedup, export Notion) au moment du fork.

## Architecture cible

```
job-agregator/
├── config/search.config.ts   # exclude, salaryMin, locations… (critères de filtrage statiques)
├── src/
│   ├── sources/              # un fichier par jobboard (interface ScrapingSource)
│   ├── lib/source-interface.ts  # ScrapingSource + type RawJobOffer
│   ├── lib/logger.ts
│   ├── filter.ts             # filtre DÉTERMINISTE pur : (offer, config) => boolean
│   ├── settings.ts           # config EFFECTIVE (table settings) seedée depuis search.config.ts
│   ├── store/sqlite.ts       # dedup par hash + liked/deleted/published_at + tables settings/runs
│   ├── shared/types.ts       # types du contrat d'API (partagés src/server ↔ web)
│   ├── server/               # serveur Fastify local (API REST + SSE de run)
│   └── index.ts              # orchestrateur (lançable CLI ou spawné par le serveur)
├── web/                      # UI Vite/React (3 pages : Paramètres / Stats / Offres)
├── public/logos/             # logos des sources (assets locaux .svg)
├── docs/api-contract.md      # contrat d'API figé (source de vérité)
├── data/job-agregator.db     # sqlite (gitignored)
└── .env                      # creds sources (plus de secrets Notion)
```

### Flux config : settings sqlite → filtre

La config **effective** vit dans la table sqlite `settings` (clé/valeur), seedée
une première fois depuis `config/search.config.ts` + le registry des sources.
L'UI pilote `terms[]`, `contractTypes` (`"stage"` / `"CDI"`) et `enabledSources[]`
via `src/settings.ts`. À chaque run, l'orchestrateur lit `getSettings()` et fusionne
ces champs dans la config passée au filtre déterministe. Les autres critères
(`exclude`, `salaryMin`, `locations`…) restent dans `search.config.ts`.

### Run en sous-process

Un run du pipeline reste **lançable en CLI** (`npm run fetch`). Le serveur web le
déclenche en **spawnant `tsx src/index.ts`** : l'orchestrateur émet des lignes
JSON de progression sur stdout (préfixe `@@RUN `) que le serveur relaie en **SSE**
(`GET /api/run/stream`). Un **verrou en mémoire serveur** garantit un seul run à la
fois (2e `POST /api/run` → `423`). Chaque run écrit une ligne dans la table `runs`
(durée, found, new, duplicates, per_source).

## Règles de contribution

### Filtrage = déterministe, pur, testable

- Toute la logique de filtre vit dans `src/filter.ts` sous forme de **fonctions
  pures** : `(offer, config) => boolean | number`. Aucun I/O, aucun appel réseau,
  aucun LLM.
- Les critères (`exclude`, `salaryMin`, `locations`, `contractTypes`) viennent
  **uniquement** de `config/search.config.ts`. Pas de critère codé en dur ailleurs.
- Un changement de filtrage doit être lisible en `git diff` et couvert par un test.

### Observabilité = diagnostiquer une panne de scraping/parsing en un coup d'œil

- **Logger** (`src/lib/logger.ts`) : niveaux `DEBUG<INFO<WARN<ERROR` (seuil via
  `LOG_LEVEL`, défaut INFO). Chaque ligne part sur **stderr** (jamais stdout,
  réservé au protocole SSE `@@RUN `) **et** est persistée dans
  `data/logs/run-<ts>.log` (un fichier par process, greppable après coup).
- **Rapport de parsing** (`src/lib/parse-report.ts`) : chaque source construit un
  `ParseReport`, alimenté via `finalizeOffers(...)`. En fin de run de source il
  loggue un **bilan** (cartes vues / ignorées + taux de remplissage par champ) et
  lève un **WARN ciblé** quand un champ est vide à 100 % (= sélecteur cassé) ou
  qu'une date brute n'a pas été reconnue par `parsePublishedAt` (à étendre dans
  `src/lib/dates.ts`).
- **Capture post-mortem** (`src/lib/debug-capture.ts`) : sur 0 carte en page 1,
  la source fige `data/debug/<source>-zero-cards-<ts>.{html,png}` pour re-dériver
  le sélecteur sans relancer à la main. Best-effort, jamais bloquant.
- `data/logs` et `data/debug` vivent sous `data/` → gitignored.

### Sources

- Chaque source implémente l'interface `ScrapingSource` :
  `fetch(options?: FetchOptions) => Promise<RawJobOffer[]>`.
- Une source ne fait **que** récupérer et normaliser des offres brutes. Elle
  **n'écrit pas** en base, ne filtre pas, ne pousse pas vers Notion.
- Les sources legacy fragiles (Indeed anti-bot, LinkedIn via email, Google Alerts
  RSS) sont traitées en **best-effort** : une source qui échoue ne casse pas le run.

### Déduplication

- Le dedup est centralisé dans `src/store/sqlite.ts`.
- La clé de dedup est un **hash composite normalisé** (`title + company +
  location`), pas l'URL seule (les re-posts changent d'URL).
- La **suppression** d'offre est un **soft-delete** (colonne `deleted`) : cachée
  de l'UI, toujours connue du dédup, jamais re-proposée.
- `notified_notion` est **obsolète** (Notion supprimé) : la colonne reste pour
  compat mais n'est plus utilisée. L'orchestrateur compte désormais
  explicitement `new` vs `duplicates` (fini l'`INSERT OR IGNORE` muet).

### UI web locale (remplace Notion)

- Serveur **Fastify** dans `src/server/`, lié à **`127.0.0.1` uniquement**.
- API REST + SSE : contrat **figé** dans `docs/api-contract.md`, types partagés
  dans `src/shared/types.ts` (importés par `src/server/` ET `web/`).
- UI **Vite/React** dans `web/` : 3 pages (Paramètres / Stats / Offres).
- Logos des sources : assets locaux `public/logos/{sourceName}.svg`.
- Plus aucun secret Notion ; les seuls secrets restants sont les creds sources.

### Secrets & config

- Aucun secret en clair dans le repo. Tout passe par `.env` (gitignored).
- `data/` et `*.db` sont gitignored : la base sqlite est locale et reconstructible.

## Check-list avant d'ajouter une source

1. Créer `src/sources/<nom>.ts` implémentant `ScrapingSource`.
2. La source accepte un `keyword` (= le terme) et rend des `RawJobOffer[]`.
3. Gérer les erreurs en best-effort (log + tableau vide, pas d'exception qui
   remonte jusqu'à casser le run).
4. L'enregistrer dans le registry des sources.
5. Ne rien filtrer ni dédoublonner dans la source — c'est le rôle de
   `filter.ts` et `store/sqlite.ts`.
