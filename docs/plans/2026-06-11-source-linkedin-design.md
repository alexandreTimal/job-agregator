# Source LinkedIn (endpoint guest) — Design

> Statut : validé le 2026-06-11. Implémentation à suivre via writing-plans.

## Objectif

Ajouter une source `linkedin` à l'agrégateur pour récupérer des offres depuis
LinkedIn, en best-effort, sans authentification ni LLM, dans le respect des
conventions du projet (`ScrapingSource`, filtre déterministe en aval,
observabilité via `ParseReport`).

## Décision d'architecture : endpoint guest, pas de login

LinkedIn expose deux voies. On retient l'**endpoint guest** non authentifié :

```
https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=<terme>&location=<ville>&start=<offset>
```

Il rend un **fragment HTML** de cartes d'offres, paginé par `start`. Avantages
vs la voie « session authentifiée façon WTTJ » :

- Pas de `storageState` à exporter ni à régénérer, pas d'outil `linkedin:login`.
- DOM guest plus stable que la SPA authentifiée.

Contrepartie acceptée : champs limités (pas de salaire ni de type de contrat),
endpoint rate-limité (HTTP 429/999 si frappé trop vite).

### Pourquoi via le navigateur et pas un `fetch` Node

Un `fetch` Node brut sur cet endpoint se fait bloquer (`429`/`999`). On le charge
donc **via `launchBrowser()` + stealth** (comme WTTJ) : `page.goto(url)` rend le
fragment, parsing par `page.evaluate`. La source est `kind: "web"`.

## Fichier `src/sources/linkedin.ts`

Calqué sur `src/sources/wttj.ts`, **sans le bloc auth** :

- **Boucle de termes interne** : un seul navigateur réutilisé, dédup par URL via
  un `Set` à travers termes + pages ; écoute `options.signal` pour fermer le
  navigateur sur abort (timeout orchestrateur).
- **Pagination par `start`** : offset incrémenté du **nombre de cartes
  réellement renvoyées** (l'endpoint en rend un nombre variable). Arrêt quand une
  page rend 0 carte (comme WTTJ borne la pagination). `maxPages` = `options.maxPages`.
- **Délai poli** (~1500 ms) entre pages et entre termes.
- `ParseReport` + `finalizeOffers` ; `captureFailure` sur 0 carte en page 1
  (couvre à la fois sélecteur cassé et rate-limit).
- Best-effort strict : toute erreur → log + `[]`, jamais d'exception qui casse le run.
- Repli `filters.keyword` accepté si `terms` absent (rétro-compat, comme WTTJ).

### Sélecteurs (LinkedIn guest — cartes `div.base-card` / `base-search-card`)

| Champ            | Sélecteur                                   |
|------------------|---------------------------------------------|
| `title`          | `.base-search-card__title`                  |
| `company`        | `.base-search-card__subtitle`               |
| `location`       | `.job-search-card__location`                |
| `urlSource`      | `a.base-card__full-link[href]` (URL nettoyée) |
| `publishedRaw`   | `time[datetime]` (attribut ISO `YYYY-MM-DD`) |
| `salary`         | `null` (absent du guest)                    |
| `contractType`   | `null` (absent du guest)                    |

Cartes ignorées : `noHref` (pas de lien) / `noTitle` (titre vide), comptés dans
le `PageDiag.dropped` comme WTTJ.

### Dates

Les dates guest sont des **ISO** (`datetime="2026-06-09"`) → déjà gérées par
`parsePublishedAt` (branche ISO `YYYY-MM-DD`). **Aucune extension de
`src/lib/dates.ts` nécessaire.** Repli sur le `textContent` du `<time>` si
l'attribut manque ; les dates non reconnues remonteront via le WARN existant du
`ParseReport`.

## Localisation & filtres

La source lit `filters.locations[0].label` (la 1ʳᵉ ville, comme WTTJ — ici
`"Paris"`) pour le paramètre `location`. Sans localisation configurée, on omet le
paramètre (recherche mondiale). Le `remote`, le contrat et le salaire restent au
**filtre déterministe en aval** (`src/filter.ts`) — aucune logique métier dans la
source.

## Câblage

1. `src/sources/registry.ts` → importer et ajouter `linkedinSource` ; mettre à
   jour le commentaire « À porter ensuite » (retirer `linkedin`).
2. `web/pages/Settings.tsx` → `KNOWN_SOURCES` : `{ name: "linkedin", label: "LinkedIn" }`.
3. `public/logos/linkedin.svg` → logo officiel (« in » blanc sur carré bleu `#0A66C2`).

### Activation par défaut

**Non activée par défaut.** La base étant déjà seedée, ajouter `linkedin` au
registry ne touche pas `enabledSources` persisté → la source reste décochée
jusqu'à action UI. Pas de special-casing du seed (cohérent avec greenhouse/lever,
eux aussi seed-activés mais inertes sans config). Si un futur reseed sur base
vierge devait l'exclure, ce serait un changement séparé.

## Tests (`src/sources/linkedin.test.ts`)

Deux helpers **purs** extraits et testés (`node:test`), ce que CLAUDE.md exige
pour la logique pure :

- `buildGuestSearchUrl(term, location, start)` → URL/encodage corrects
  (espaces encodés, `start` présent, `location` omis si vide).
- `cleanJobUrl(href)` → strip des paramètres de tracking
  (`?refId=…&trackingId=…`) → URL canonique `…/jobs/view/<id>`.

Le parsing in-DOM reste non testé unitairement (browser-bound, comme WTTJ) ;
l'orchestration globale est déjà couverte par `src/orchestrator.test.ts`.

## Non-objectifs (YAGNI)

- Pas de session authentifiée, pas d'outil de login.
- Pas de récupération de salaire / contrat (absents du guest).
- Pas de filtres LinkedIn serveur (`f_TPR`, `geoId`…) au-delà de keyword +
  location : le filtrage fin reste déterministe en aval.
