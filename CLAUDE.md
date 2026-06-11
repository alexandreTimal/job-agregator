# CLAUDE.md — Guide de collaboration agent ↔ repo

Ce fichier documente les conventions que tout agent (Claude Code, Copilot, etc.)
doit respecter avant de modifier le projet. Les règles ici priment sur les
habitudes par défaut de l'agent.

## Nature du projet

`job-agregator` est un **fork allégé** de `Job_watcher`. C'est un **agrégateur
de jobboards maison**, déterministe et sans interface utilisateur :

```
config.terms → [par terme × par source] fetch → dedup (sqlite) → filtre déterministe → export Notion
```

Objectif : remplacer les alertes natives (peu fiables) et les filtres faibles
des jobboards par un système maison qui fetch **toutes** les offres à partir de
**termes choisis à la main**, applique **notre propre filtrage**, et **pousse le
résultat dans une base Notion**.

### Différences assumées avec le repo d'origine `Job_watcher`

- **Pas de LLM.** Aucun appel à un modèle, aucun prompt. Le repo d'origine est un
  banc d'essai LLM ; ce fork est volontairement déterministe et auditable.
- **Pas de web app.** Pas de Next.js, tRPC, React, Supabase, ni auth.
- **Pas d'onboarding / profil.** Pas de CV, d'analyse d'intention, de branches,
  ni de génération de titres.
- **Stack minimale :** Node + TypeScript + `better-sqlite3`.

> Ce projet vit dans un dossier **séparé**. On ne modifie **jamais** le code du
> repo `Job_watcher` voisin ; on en copie/cherry-pick des fichiers (sources,
> dedup, export Notion) au moment du fork.

## Architecture cible

```
job-agregator/
├── config/search.config.ts   # terms, exclude, salaryMin, locations, contractTypes
├── src/
│   ├── sources/              # un fichier par jobboard (interface ScrapingSource)
│   ├── lib/source-interface.ts  # ScrapingSource + type RawJobOffer
│   ├── lib/logger.ts
│   ├── filter.ts             # filtre DÉTERMINISTE pur : (offer, config) => boolean
│   ├── store/sqlite.ts       # dedup par hash + tracking notified_notion
│   ├── notion.ts             # export Notion (REST)
│   └── index.ts              # orchestrateur (boucle termes × sources)
├── data/job-agregator.db     # sqlite (gitignored)
└── .env                      # NOTION_API_KEY, NOTION_DATABASE_ID, creds sources
```

## Règles de contribution

### Filtrage = déterministe, pur, testable

- Toute la logique de filtre vit dans `src/filter.ts` sous forme de **fonctions
  pures** : `(offer, config) => boolean | number`. Aucun I/O, aucun appel réseau,
  aucun LLM.
- Les critères (`exclude`, `salaryMin`, `locations`, `contractTypes`) viennent
  **uniquement** de `config/search.config.ts`. Pas de critère codé en dur ailleurs.
- Un changement de filtrage doit être lisible en `git diff` et couvert par un test.

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
- Le flag `notified_notion` garantit l'idempotence : un run interrompu ne
  re-pousse jamais une offre déjà envoyée.

### Export Notion

- Tout le mapping Notion vit dans `src/notion.ts`.
- Respecter le rate-limit (~350 ms entre requêtes).
- Les secrets (`NOTION_API_KEY`, `NOTION_DATABASE_ID`) viennent de `.env`,
  jamais du code.

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
