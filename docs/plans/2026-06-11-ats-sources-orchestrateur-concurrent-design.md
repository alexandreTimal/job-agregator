# Design — Adapters ATS (Greenhouse / Lever) + orchestrateur concurrent

**Date :** 2026-06-11
**Statut :** validé
**Périmètre :** deux chantiers décidés en brainstorming —
1. Sources ATS génériques (Greenhouse + Lever) en API JSON, boards éditables depuis l'UI.
2. Orchestrateur à concurrence bornée (fin du run strictement séquentiel).

## Contexte & motivation

L'agrégateur ne sait scraper que des jobboards web « à cartes » (WTTJ, HelloWork)
via Playwright/DOM. Pour couvrir les **pages carrières de grosses entreprises** et
**Station F**, le bon levier n'est pas un scraper par entreprise mais des **adapters
par ATS** : Greenhouse et Lever exposent des **API JSON publiques** qui renvoient
tout le board d'une entreprise. Un seul adapter + une liste de boards = des dizaines
d'entreprises, sans navigateur, stable.

En parallèle, l'orchestrateur boucle `for term { for source { await fetch } }` →
N×M lancements Chromium **en série**. Au-delà de 4-5 sources, le run devient trop
long. On le passe en **concurrence bornée**.

### Endpoints ATS vérifiés (réponses réelles, 2026-06-11)

- **Greenhouse** `GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true`
  → `jobs[]` avec `title`, `company_name`, `location.name`, `absolute_url`,
  `first_published` / `updated_at` (ISO), `content` (description HTML).
  Vérifié sur `stripe`.
- **Lever** `GET https://api.lever.co/v0/postings/{board}?mode=json`
  → tableau de postings avec `text` (titre), `categories.{location,commitment,team}`,
  `hostedUrl`, `createdAt` (epoch ms), `descriptionPlain`. Vérifié sur `swile` (FR).
  Board inexistant → `{ok:false,error:"Document not found"}` ; board vide → `[]`.

## Décisions de design (issues du brainstorming)

1. **Filtrage ATS = inclusion par terme, ATS uniquement.** Une offre d'un board
   n'est gardée que si son **titre** matche ≥1 `terms`. Les sources web restent
   inchangées (recherche serveur via `keyword`).
2. **Boards éditables depuis l'UI** (page Paramètres), stockés en sqlite
   (`settings.atsBoards`, JSON). Le plus simple et conforme à « l'UI pilote
   `enabledSources` ».
3. **Concurrence : borne globale 3-4** sources en parallèle + timeout par source.

## Architecture

### Arborescence

```
src/sources/ats/
  shared.ts        # fetchJson() natif + matchesAnyTerm() + scaffold d'itération boards
  greenhouse.ts    # name:"greenhouse", kind:"ats"
  lever.ts         # name:"lever", kind:"ats"
src/lib/concurrency.ts   # pLimit(n) maison (~15 lignes, zéro dépendance)
```

**Aucune nouvelle dépendance** : `fetch` natif (Node 18+), pas de `got`/`axios`,
pas de `p-limit` npm.

### B. Modèle de source : une tâche par source (cœur du chantier 2)

On abandonne le produit cartésien `term × source`. **Chaque source = une seule
tâche** qui reçoit *tous* les termes et boucle elle-même :

- **Sources web** (WTTJ/HelloWork) : bouclent leurs termes **en interne**,
  réutilisent un seul navigateur + leurs délais polis existants (1,5 s). Un site
  n'est donc jamais frappé deux fois simultanément.
- **Sources ATS** : fetchent chaque board **une fois**, matchent contre tous les
  termes.

Conséquence : la liste de tâches = la liste des sources actives (hôtes distincts).
Le pool borné à 4 ne crée **jamais** de parallélisme intra-site → plus optimal
**et** plus sûr côté anti-bot.

**Changement requis sur les 2 sources web** (assumé) : envelopper la logique de
fetch existante dans un `for (term of terms)`, étendre leur `Set seen` à travers
les termes. `FetchOptions.filters.keyword` (singulier) → `FetchOptions.terms: string[]`.

### C. Concurrence (`src/lib/concurrency.ts`)

`pLimit(4)` maison. Chaque tâche = `Promise.race([source.fetch(...), timeout])`,
**timeout par source ~4 min** (une source traite désormais tous ses termes).
Timeout ou exception → log WARN + `[]`, jamais de crash (best-effort conservé).
L'orchestrateur passe de la double boucle `await` séquentielle à
`await Promise.all(tasks.map(limit))`, puis **dedup / filtre / score inchangés**.

### D. Inclusion par terme = émulation de recherche (ATS only)

`passesFilters` (filter.ts) reste **pur et inchangé** et **ne connaît pas** la
notion d'ATS. Le match positif par terme vit dans la source ATS — c'est
l'équivalent du `keyword` que les sites web obtiennent côté serveur — via un
helper **pur et testable** `matchesAnyTerm(title, terms)` dans `shared.ts`.
Flux d'une offre ATS : board → `matchesAnyTerm(title)` → `finalizeOffers` →
filtre existant (exclude/contrat/salaire/lieu) → dedup → score.

### E. Boards éditables depuis l'UI (chantier 1)

- **sqlite** : nouvelle clé `atsBoards` dans la table `settings`, JSON
  `{ greenhouse: string[], lever: string[] }`. Seed par défaut : `{}`.
- **Types partagés** (`src/shared/types.ts`) : `Settings.atsBoards` ajouté ;
  `getSettings()` / `saveSettings()` étendus (`src/settings.ts`).
- **Source ↔ boards** : l'orchestrateur lit `settings.atsBoards[source.name]` et
  le passe en `FetchOptions.boards`. `greenhouse` / `lever` deviennent des sources
  togglables via `enabledSources` comme les autres (désactivées tant qu'aucun board).
- **Interface** (`src/lib/source-interface.ts`) : `ScrapingSource.kind?: "web" | "ats"`
  (défaut `"web"`) pour que l'orchestrateur sache router (une tâche tous-termes
  pour ATS vs source web qui boucle ses termes — même contrat `fetch(opts)`).
- **API** : `GET/PUT /api/settings` transporte déjà l'objet settings → on y ajoute
  `atsBoards` (mise à jour de `docs/api-contract.md`).
- **UI Paramètres** : sous chaque source ATS activée, un éditeur de liste (chips +
  champ d'ajout + suppression), 100 % design-system (`Input`, `Button`,
  `Badge tone="mono"`, icônes `aria-hidden`, a11y conforme WCAG AA). Saisie = le
  `boardToken` (ex. `swile`, `stripe`).

### Mapping ATS → RawJobOffer

| RawJobOffer      | Greenhouse                         | Lever                              |
|------------------|------------------------------------|------------------------------------|
| `title`          | `title`                            | `text`                             |
| `company`        | `company_name`                     | board token (label)                |
| `location`       | `location.name`                    | `categories.location`              |
| `salary`         | `null`                             | `null`                             |
| `contractType`   | `null` (lenient)                   | `categories.commitment` (raw)      |
| `urlSource`      | `absolute_url`                     | `hostedUrl`                        |
| `publishedAt`    | `first_published` \|\| `updated_at`| `createdAt` (epoch ms → Date)      |
| `descriptionRaw` | `content` (HTML)                   | `descriptionPlain`                 |
| `sourceName`     | `"greenhouse"`                     | `"lever"`                          |

## Gestion d'erreurs

- Board inexistant (`{ok:false}`) ou vide (`[]`) → skip + log, pas d'exception.
- Échec réseau / timeout d'un board → board ignoré, les autres boards continuent.
- Échec/timeout d'une source entière → `[]`, run continue (best-effort strict).
- Champ vide à 100 % sur un board → WARN via `ParseReport` (sélecteur/clé cassée).

## Tests

- `matchesAnyTerm` : pur, table de cas (match/accent/casse/no-match).
- `mapGreenhouseJob` / `mapLeverPosting` : purs, fixtures JSON figées (réponses
  réelles vérifiées ci-dessus).
- `pLimit` : jamais > n tâches en vol ; propagation timeout → `[]`.
- Sources ATS : `fetch` mocké — board ok / `{ok:false}` / `[]`.

## Hors périmètre (YAGNI)

- Indeed / LinkedIn (anti-bot lourd — chantier ultérieur, best-effort assumé).
- Autres ATS (Workday, SmartRecruiters, Teamtailor) — même patron à dupliquer plus tard.
- Filtrage ATS sur la description (titre suffit pour l'instant).
- Pilotage UI du timeout / de la borne de concurrence (constantes pour l'instant).
