# CLAUDE.md — Guide de collaboration agent ↔ repo

Ce fichier documente les conventions que tout agent (Claude Code, Copilot, etc.)
doit respecter avant de modifier le projet. Les règles ici priment sur les
habitudes par défaut de l'agent.

## Nature du projet

`job-agregator` est un **fork allégé** de `Job_watcher`. C'est un **agrégateur
de jobboards maison**, déterministe, doublé d'une **UI web locale** (mono-utilisateur,
`localhost`) qui a **remplacé Notion** :

```
settings (sqlite) → fetch concurrent [1 tâche/source, tous les termes] → dedup (sqlite) → filtre déterministe → base sqlite ← UI web locale
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
│   ├── sources/              # une source par jobboard (interface ScrapingSource)
│   │   └── ats/              # adapters ATS génériques (Greenhouse/Lever) : API JSON par board
│   ├── lib/source-interface.ts  # ScrapingSource (kind web|ats) + FetchOptions (terms/boards/signal)
│   ├── lib/logger.ts
│   ├── lib/concurrency.ts    # pLimit + withTimeout (orchestrateur concurrent borné)
│   ├── filter.ts             # filtre DÉTERMINISTE pur : (offer, config) => boolean
│   ├── settings.ts           # config EFFECTIVE (table settings) seedée depuis search.config.ts
│   ├── store/sqlite.ts       # dedup par hash + liked/deleted/published_at + tables settings/runs
│   ├── shared/types.ts       # types du contrat d'API (partagés src/server ↔ web)
│   ├── server/               # serveur Fastify local (API REST + SSE de run)
│   └── index.ts              # orchestrateur : runPipeline() concurrent (lançable CLI ou spawné par le serveur)
├── web/                      # UI Vite/React (3 pages : Paramètres / Stats / Offres)
├── public/logos/             # logos des sources (assets locaux .svg)
├── docs/api-contract.md      # contrat d'API figé (source de vérité)
├── data/job-agregator.db     # sqlite (gitignored)
└── .env                      # creds sources (plus de secrets Notion)
```

### Flux config : settings sqlite → filtre

La config **effective** vit dans la table sqlite `settings` (clé/valeur), seedée
une première fois depuis `config/search.config.ts` + le registry des sources.
L'UI pilote `terms[]`, `contractTypes` (`"stage"` / `"CDI"`), `enabledSources[]` et
`atsBoards` (Record `{<source ATS>: tokens d'entreprise[]}`, ex. `{ greenhouse: ["stripe"] }`)
via `src/settings.ts`. À chaque run, l'orchestrateur lit `getSettings()` et fusionne
ces champs dans la config passée au filtre déterministe ; il route `atsBoards[<source>]`
vers la source ATS correspondante. Les autres critères (`exclude`, `salaryMin`,
`locations`…) restent dans `search.config.ts`.

### Run en sous-process

Un run du pipeline reste **lançable en CLI** (`npm run fetch`). Le serveur web le
déclenche en **spawnant `tsx src/index.ts`** : l'orchestrateur émet des lignes
JSON de progression sur stdout (préfixe `@@RUN `) que le serveur relaie en **SSE**
(`GET /api/run/stream`). Un **verrou en mémoire serveur** garantit un seul run à la
fois (2e `POST /api/run` → `423`). Chaque run écrit une ligne dans la table `runs`
(durée, found, new, duplicates, per_source).

### Orchestration concurrente (une tâche par source)

Le cœur du pipeline est **`runPipeline()`** (exporté par `src/index.ts`, donc
testable hors process ; `main()` ne s'exécute qu'en entrée CLI/spawn grâce à un garde
`isEntry`). Chaque source active = **une seule tâche** lancée via
`pLimit(SOURCE_CONCURRENCY = 4)` + un timeout par source (`withTimeout`, 600 s par
défaut, surchargeable via `JOB_AGREGATOR_SOURCE_TIMEOUT_MS` ; helpers dans
`src/lib/concurrency.ts`). Une source reçoit **tous** les `terms` d'un
coup : les sources web bouclent leurs termes **en interne** en réutilisant un seul
navigateur — ainsi un même hôte n'est **jamais** frappé en parallèle (sûr anti-bot).
Au timeout/erreur, l'orchestrateur `abort()` la source via `FetchOptions.signal` (les
sources web ferment alors leur navigateur). Il **ré-attend ensuite la promesse de
`fetch`** (bornée par `ABORT_GRACE_MS = 15 s`) pour **récupérer la collecte partielle**
que la source restitue dans son `catch` : sans ça, `withTimeout` ayant déjà rejeté,
cette moisson tardive serait silencieusement jetée (un run tronqué = 0 offre).
Best-effort strict conservé : une source qui échoue/expire sans rien collecter rend
`[]`, le run va toujours jusqu'à `done`. La dédup/filtre/score s'applique ensuite sur
l'agrégat de toutes les sources.

## Règles de contribution

### Filtrage = déterministe, pur, testable

- Toute la logique de filtre vit dans `src/filter.ts` sous forme de **fonctions
  pures** : `(offer, config) => boolean | number`. Aucun I/O, aucun appel réseau,
  aucun LLM.
- Les critères (`exclude`, `salaryMin`, `locations`, `contractTypes`) viennent
  **uniquement** de `config/search.config.ts`. Pas de critère codé en dur ailleurs.
- Un changement de filtrage doit être lisible en `git diff` et couvert par un test.

### Tests

- Runner **natif** `node:test` + `node:assert` via tsx (`npm test`, glob
  `src/**/*.test.ts`) — **zéro dépendance de test**. Toute logique pure (filtre,
  mappers de sources ATS, helpers de dates/concurrence) doit être couverte.
- L'orchestration a un **test d'intégration** (`src/orchestrator.test.ts`) qui exerce
  `runPipeline` (routage `atsBoards`, dédup inter-sources, compteurs, best-effort) sur
  une base sqlite **temporaire isolée** via la var d'env `JOB_AGREGATOR_DB`. Un test ne
  doit **jamais** toucher la vraie base `data/job-agregator.db`.

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
  `fetch(options?: FetchOptions) => Promise<RawJobOffer[]>`, avec un `kind` (`"web"`
  par défaut, ou `"ats"`).
- Une source ne fait **que** récupérer et normaliser des offres brutes. Elle
  **n'écrit pas** en base, ne filtre pas (au sens `filter.ts`), ne pousse pas vers Notion.
- Une source reçoit `FetchOptions.terms` (tous les termes du run), `boards` (sources
  ATS) et `signal` (abort sur timeout). Les sources **web** bouclent ces termes en
  interne (un seul navigateur, dédup par URL à travers termes+pages) et écoutent
  `signal` pour fermer leur navigateur ; un `filters.keyword` unique reste accepté en repli.
- **Sources ATS (Greenhouse, Lever — `src/sources/ats/`)** : `kind: "ats"`. Elles
  interrogent une **API JSON par board** (token d'entreprise, listés dans
  `settings.atsBoards[<source>]` et édités depuis l'UI Paramètres), pas un DOM. L'API
  rend TOUT le board : la source ne garde que les offres dont le **titre** matche un
  terme (`matchesAnyTerm`, `src/sources/ats/shared.ts`). C'est une **émulation de la
  recherche serveur** (l'équivalent du `keyword` des sources web), **pas** du filtrage
  métier — `src/filter.ts` reste pur et n'a aucune notion d'ATS. Helpers communs :
  `fetchJson` (GET best-effort, `null` sur anomalie) + `matchesAnyTerm`.
- Les sources legacy fragiles (Indeed anti-bot, LinkedIn via email, Google Alerts
  RSS) sont traitées en **best-effort** : une source qui échoue ne casse pas le run.
- **WTTJ requiert une session authentifiée.** Sa recherche par mot-clé
  (`/fr/jobs-matches?classic-search=1`) est derrière un login ; la source rejoue
  un `storageState` Playwright exporté une fois via `npm run wttj:login` (chemin
  par défaut `data/wttj-session.json`, gitignored ; surchargeable par
  `WTTJ_STORAGE_STATE`). Constantes partagées login↔scrape dans
  `src/sources/wttj-session.ts`. Aucun mot de passe ne transite par le code (saisie
  dans la fenêtre navigateur). Session absente/expirée → WARN actionnable + `[]`.

### Déduplication

- Le dedup est centralisé dans `src/store/sqlite.ts`.
- La clé de dedup est un **hash composite normalisé** (`title + company`), pas
  l'URL seule (les re-posts changent d'URL). Le **lieu est volontairement EXCLU**
  du hash : les sources le rendent de façon instable (« Paris » → « Paris 9e »…),
  ce qui faisait varier le hash d'un re-post et le faisait échapper à la dédup —
  et surtout à la suppression (une offre soft-deleted réapparaissait). Compromis
  assumé : un même intitulé chez une même entreprise dans deux villes = une offre.
  Changer ce schéma impose une migration des `hash` existants (`migrateHashScheme`,
  versionnée par `PRAGMA user_version`, fusionne les collisions).
- La **suppression** d'offre est un **soft-delete** (colonne `deleted`) : cachée
  de l'UI, toujours connue du dédup (`offerExists` ignore `deleted`), jamais
  re-proposée même si le re-post revient avec un lieu différent.
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
- **Client API (`web/lib/api-client.ts`) : ne JAMAIS envoyer `Content-Type:
  application/json` sur une requête SANS corps.** Le helper `http()` ne pose cet
  en-tête que si `init.body` est défini : Fastify rejette tout body JSON vide
  (`FST_ERR_CTP_EMPTY_JSON_BODY` → HTTP 400). C'est ce qui cassait le bouton
  poubelle (`POST /api/offers/:id/delete`, sans corps). Tout POST bodyless doit
  passer par `http()` sans forcer ce header.

### Lancement & autostart (service systemd `--user`)

- **Servir l'UI** : `npm run serve` (= `tsx src/server/index.ts`) sert le SPA
  **déjà buildé** dans `web/dist` sur `127.0.0.1:5627` (surchargeable par `PORT`).
  `npm run start` (= `vite build && tsx …`) ne sert qu'au lancement manuel one-shot.
- **Autostart** : `npm run autostart:install` écrit le service systemd `--user`
  (`~/.config/systemd/user/job-agregator.service`), **builde le SPA une seule
  fois**, active le linger, puis démarre le service. `ExecStart=npm run serve`
  **ne rebuilde pas** : un rebuild dans `ExecStart` laisserait une fenêtre de
  ~20 s sans serveur à chaque `Restart=on-failure` (requêtes navigateur qui
  échouent). **Après tout changement de code frontend, relancer `npm run build`**
  (ou `npm run autostart:install`) pour rafraîchir `web/dist`, sinon le service
  sert un bundle périmé.

### Design system & conventions UI/UX (À RESPECTER)

L'UI suit une direction esthétique **« control-room » sombre, éditorial-terminal**.
Tout nouvel écran/composant doit s'y conformer pour rester cohérent. Ne JAMAIS
réintroduire de CSS ad hoc, de styles inline (`style={{ color: … }}`), ni de
couleurs/tailles en dur : tout passe par Tailwind + les tokens.

**Stack UI**

- **Tailwind CSS v4** (plugin `@tailwindcss/vite`, zéro fichier de config). Tokens
  et thème dans `web/styles/globals.css` (bloc `@theme`), importé une seule fois
  dans `web/main.tsx`.
- Primitives façon shadcn **maison** dans `web/components/ui/*`
  (`Button`, `Card`, `Badge`, `Segmented`, `Switch`, `Input`) bâties avec
  `class-variance-authority` (`cva`). Icônes via **`lucide-react`**.
- Helper de classes obligatoire : `cn()` (`web/lib/utils.ts`, = `clsx` +
  `tailwind-merge`). Alias d'import : **`@` → `web/`**.

**Tokens (jamais de hex/px en dur — utiliser ces variables)**

- Surfaces : `--color-base` (fond), `--color-panel`/`--color-panel-2` (cartes),
  `--color-line`/`--color-line-strong` (bords).
- Texte (paliers, déjà calibrés WCAG AA) : `--color-ink` > `--color-ink-soft` >
  `--color-ink-mute` > `--color-ink-faint`. **`--color-ink-faint` est réservé aux
  icônes décoratives et micro-texte ; ne pas l'utiliser pour du texte porteur de
  sens** (il est le palier le plus limite).
- Accents : `--color-signal` (lime, action principale), `--color-amber` (favoris),
  `--color-danger` (suppression/erreur).
- Rayons : `--radius-xs|sm|md|lg|xl`. Ombres : `--shadow-panel`, `--shadow-pop`.
  Courbe d'anim : `--ease-out-expo`.
- Usage en classe arbitraire : `text-[var(--color-ink-soft)]`,
  `rounded-[var(--radius-md)]`, `border-[var(--color-line)]`.

**Typographie (3 familles, rôles fixes)**

- `--font-serif` (Instrument Serif) : grands titres de page + chiffres-clés.
- `--font-sans` (Hanken Grotesk) : corps & UI (défaut).
- `--font-mono` (Geist Mono) : **toute donnée** (scores masqués, dates, durées,
  noms de source, compteurs, index). Classe : `font-[family-name:var(--font-mono)]`.

**Composants — toujours réutiliser, ne pas refaire**

```tsx
import { Button } from "@/components/ui/button";   // variant: signal|outline|ghost|danger ; size: sm|md|lg|icon
import { Card } from "@/components/ui/card";        // panneau standard (bord + ombre + blur)
import { Badge } from "@/components/ui/badge";      // tone: neutral|signal|amber|mono
import { Segmented } from "@/components/ui/segmented"; // choix exclusif (radiogroup + clavier)
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

<Button variant="signal"><Plus aria-hidden="true" className="size-4" /> Ajouter</Button>
<Card className="p-6">…</Card>
<Badge tone="mono">{formatDuree(ms)}</Badge>
```

**Patterns de page (cohérence inter-pages)**

- L'en-tête éditorial (kicker mono `/route`, titre serif, accroche) est géré par
  le **shell** (`web/App.tsx` + `web/lib/routes.tsx`). Une page rend uniquement son
  corps dans une `<section>` ; **pas de second `<h1>`**.
- Titre de bloc interne : `<h2>` via le helper `SectionTitle` (icône + label
  uppercase mono). Respecter l'ordre des titres (h1 shell → h2 → h3).
- États standard d'une page liste/données :
  - **chargement** → skeletons (`animate-pulse`, blocs `bg-[var(--color-panel)]/40`),
    conteneur `aria-hidden="true"` + `aria-busy` sur la section + `<span className="sr-only">Chargement…</span>`.
  - **erreur** → encart `role="alert"` bord/texte `--color-danger`.
  - **vide** → encart pointillé centré (icône `aria-hidden`, titre `ink-soft`, aide `ink-mute`).
- Apparition en cascade : classe `stagger` sur le conteneur + `style={{ "--i": n } as React.CSSProperties}`
  sur chaque enfant direct (voir keyframes dans `globals.css`).

**Accessibilité — non négociable (WCAG 2.2 AA)**

- **Toute icône lucide décorative porte `aria-hidden="true"`.** Un bouton-icône
  (sans texte) porte un `aria-label` explicite (le `title` ne suffit pas).
- On/off → `role="switch"` + `aria-checked` (PAS `aria-pressed`). Choix exclusif →
  `Segmented` (`radiogroup`, navigation flèches déjà gérée). Groupe de réglages →
  `role="group"` + `aria-labelledby` pointant le `<h2>` de section.
- Liens `target="_blank"` : `rel="noopener noreferrer"` + mention SR
  `<span className="sr-only"> (nouvel onglet)</span>`.
- Cibles tactiles ≥ 24px (préférer `size-8`/`size-9`). Le focus visible est global
  (`:focus-visible` dans `globals.css`) — ne pas le désactiver.
- Messages de statut sur un nœud **stable** avec `role="status" aria-live="polite"`.
- Respecter `prefers-reduced-motion` (déjà neutralisé globalement — ne pas
  contourner avec des anims JS).

**Règle produit : le `score` des offres N'EST PAS affiché** (ni mètre, ni tri).
Le pipeline ne score pas (toujours 0). `score` et `OfferSort = "recent" | "score"`
restent dans le contrat figé mais **ne sont pas surfacés dans l'UI** ; ne pas les
ré-ajouter sans demande explicite.

**Anti-patterns interdits** : styles inline pour la présentation, hex/px en dur,
`<div>` cliquable sans rôle, nouvelle lib de composants (MUI, Chakra…), icônes non
masquées, texte porteur en `ink-faint`, fichiers `.css` par composant (tout est
Tailwind + tokens).

### Workflow Git (préférence du mainteneur)

- Projet **mono-utilisateur, local** : on travaille **directement sur `main`**.
  **Pas de branche de feature, pas de pull request.** Quand un changement est prêt
  et vérifié, `commit` **puis `push` sur `main` en direct** (override assumé de la
  règle générale « branche d'abord sur la branche par défaut »).

### Secrets & config

- Aucun secret en clair dans le repo. Tout passe par `.env` (gitignored).
- `data/` et `*.db` sont gitignored : la base sqlite est locale et reconstructible.

## Check-list avant d'ajouter une source

1. Créer `src/sources/<nom>.ts` implémentant `ScrapingSource` (préciser `kind`).
2. La source accepte `options.terms` (tous les termes du run) et rend des
   `RawJobOffer[]`. Une source web boucle ces termes en interne ; un `filters.keyword`
   unique reste accepté en repli.
3. Gérer les erreurs en best-effort (log + tableau vide, pas d'exception qui
   remonte jusqu'à casser le run) ; écouter `options.signal` pour libérer ses
   ressources sur abort (sources web : fermer le navigateur).
4. L'enregistrer dans le registry des sources (`src/sources/registry.ts`).
5. Ne rien filtrer (au sens `filter.ts`) ni dédoublonner inter-run dans la source —
   c'est le rôle de `filter.ts` et `store/sqlite.ts`.
6. **Source ATS** (API JSON par board) : `kind: "ats"`, fichier sous
   `src/sources/ats/`, lire les boards depuis `options.boards`, réutiliser
   `fetchJson`/`matchesAnyTerm` (`src/sources/ats/shared.ts`), et exposer ses boards
   dans l'UI Paramètres via `settings.atsBoards` (catalogue `KNOWN_SOURCES` marqué
   `ats: true` dans `web/pages/Settings.tsx`).
