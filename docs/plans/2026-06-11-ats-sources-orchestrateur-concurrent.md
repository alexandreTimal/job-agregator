# ATS sources + orchestrateur concurrent — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ajouter deux sources ATS génériques (Greenhouse, Lever) en API JSON dont les boards sont éditables depuis l'UI, et passer l'orchestrateur d'un run strictement séquentiel à une concurrence bornée (une tâche par source).

**Architecture :** Chaque source devient **une seule tâche** qui reçoit *tous* les termes (les sources web bouclent leurs termes en interne, réutilisant un navigateur ; les sources ATS fetchent chaque board une fois et matchent par titre). L'orchestrateur exécute ces tâches via `pLimit(4)` + timeout par source ; dedup/filtre/score restent inchangés. Le match positif par terme (inclusion ATS) vit dans la source ATS via un helper pur, `passesFilters` n'est pas touché.

**Tech Stack :** Node 24 + TypeScript + `tsx`, `fetch` natif (zéro nouvelle dépendance), runner de test natif `node:test` + `node:assert`, `better-sqlite3`, Fastify, Vite/React + Tailwind v4.

**Référence design :** `docs/plans/2026-06-11-ats-sources-orchestrateur-concurrent-design.md`.

**Conventions :** TDD pour toute logique pure. Chemins exacts. Commits fréquents. Respecter le design system UI (`CLAUDE.md` → primitives `web/components/ui/*`, tokens, a11y WCAG AA). Branche de travail : `feat/ats-sources-orchestrateur-concurrent` (déjà créée).

---

## Task 0 : Mettre en place le runner de test

**Files:**
- Modify: `package.json` (bloc `scripts`)

**Step 1 : Ajouter le script `test`**

Dans `package.json`, ajouter dans `"scripts"` (après `"fetch:dry"`) :

```json
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
```

**Step 2 : Vérifier qu'il tourne (aucun test encore → exit 0 ou « no tests »)**

Run: `npm test`
Expected: la commande s'exécute sans erreur de config (0 test trouvé est acceptable à ce stade).

**Step 3 : Commit**

```bash
git add package.json
git commit -m "chore(test): runner natif node:test via tsx (zéro dépendance)"
```

---

## Task 1 : `matchesAnyTerm()` — inclusion par terme (helper pur ATS)

**Files:**
- Create: `src/sources/ats/shared.ts`
- Test: `src/sources/ats/shared.test.ts`

**Step 1 : Écrire le test qui échoue**

`src/sources/ats/shared.test.ts` :

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAnyTerm } from "./shared";

test("matchesAnyTerm : match insensible à la casse et aux accents", () => {
  assert.equal(matchesAnyTerm("Senior Data Engineer", ["data engineer"]), true);
  assert.equal(matchesAnyTerm("Ingénieur Données", ["ingenieur donnees"]), true);
});

test("matchesAnyTerm : aucun terme ne matche", () => {
  assert.equal(matchesAnyTerm("Account Executive", ["data engineer", "ml engineer"]), false);
});

test("matchesAnyTerm : liste de termes vide → false (rien ne passe)", () => {
  assert.equal(matchesAnyTerm("Data Engineer", []), false);
});
```

**Step 2 : Lancer le test pour le voir échouer**

Run: `npm test`
Expected: FAIL — `matchesAnyTerm` introuvable / module `./shared` absent.

**Step 3 : Implémenter le minimum**

`src/sources/ats/shared.ts` :

```ts
/**
 * Briques partagées des adapters ATS (Greenhouse, Lever).
 *
 * Les API d'ATS renvoient TOUT le board d'une entreprise (pas de recherche
 * serveur). `matchesAnyTerm` émule donc le `keyword` que les sources web
 * obtiennent côté serveur : une offre n'est gardée que si son TITRE matche au
 * moins un terme. C'est une recherche, pas un filtre métier — `src/filter.ts`
 * reste pur et inchangé.
 */
import { normalizeText } from "../../lib/normalize";

/** Vrai si `title` contient au moins un des `terms` (insensible casse/accents). */
export function matchesAnyTerm(title: string, terms: string[]): boolean {
  const haystack = normalizeText(title);
  if (!haystack) return false;
  return terms.some((t) => {
    const needle = normalizeText(t);
    return needle.length > 0 && haystack.includes(needle);
  });
}
```

**Step 4 : Lancer le test pour le voir passer**

Run: `npm test`
Expected: PASS (3 tests).

**Step 5 : Commit**

```bash
git add src/sources/ats/shared.ts src/sources/ats/shared.test.ts
git commit -m "feat(ats): matchesAnyTerm — inclusion par terme (émulation de recherche)"
```

---

## Task 2 : `fetchJson()` — GET JSON best-effort (helper partagé ATS)

**Files:**
- Modify: `src/sources/ats/shared.ts`
- Test: `src/sources/ats/shared.test.ts`

**Step 1 : Écrire le test qui échoue** (ajouter à `shared.test.ts`)

```ts
import { mock } from "node:test";
import { fetchJson } from "./shared";

test("fetchJson : renvoie le JSON parsé sur 200", async () => {
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
  );
  assert.deepEqual(await fetchJson("https://x.test/a"), { ok: 1 });
  mock.restoreAll();
});

test("fetchJson : renvoie null sur statut non-2xx (best-effort)", async () => {
  mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
  assert.equal(await fetchJson("https://x.test/b"), null);
  mock.restoreAll();
});

test("fetchJson : renvoie null si fetch jette (réseau)", async () => {
  mock.method(globalThis, "fetch", async () => { throw new Error("ECONNRESET"); });
  assert.equal(await fetchJson("https://x.test/c"), null);
  mock.restoreAll();
});
```

**Step 2 : Lancer pour voir échouer**

Run: `npm test`
Expected: FAIL — `fetchJson` introuvable.

**Step 3 : Implémenter** (ajouter à `src/sources/ats/shared.ts`)

```ts
/**
 * GET JSON best-effort : renvoie l'objet parsé, ou `null` sur toute anomalie
 * (statut non-2xx, corps non-JSON, erreur réseau, timeout). Ne jette jamais —
 * une source ATS qui interroge plusieurs boards ne doit pas casser sur un seul.
 */
export async function fetchJson<T = unknown>(url: string, timeoutMs = 15_000): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: "application/json", "user-agent": "job-agregator/0.1 (+local)" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

**Step 4 : Lancer pour voir passer**

Run: `npm test`
Expected: PASS (6 tests au total).

**Step 5 : Commit**

```bash
git add src/sources/ats/shared.ts src/sources/ats/shared.test.ts
git commit -m "feat(ats): fetchJson — GET JSON best-effort (null sur anomalie)"
```

---

## Task 3 : `pLimit()` + `withTimeout()` — concurrence bornée

**Files:**
- Create: `src/lib/concurrency.ts`
- Test: `src/lib/concurrency.test.ts`

**Step 1 : Écrire le test qui échoue**

`src/lib/concurrency.test.ts` :

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pLimit, withTimeout, TimeoutError } from "./concurrency";

test("pLimit : jamais plus de n tâches en vol", async () => {
  const limit = pLimit(2);
  let inFlight = 0;
  let maxInFlight = 0;
  const task = () =>
    limit(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight}`);
});

test("pLimit : renvoie les résultats dans l'ordre des appels", async () => {
  const limit = pLimit(2);
  const out = await Promise.all([1, 2, 3].map((n) => limit(async () => n * 10)));
  assert.deepEqual(out, [10, 20, 30]);
});

test("withTimeout : résout si la promesse termine à temps", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 50), "ok");
});

test("withTimeout : rejette avec TimeoutError au-delà du délai", async () => {
  await assert.rejects(
    () => withTimeout(new Promise((r) => setTimeout(() => r("tard"), 50)), 10),
    TimeoutError,
  );
});
```

**Step 2 : Lancer pour voir échouer**

Run: `npm test`
Expected: FAIL — module `./concurrency` absent.

**Step 3 : Implémenter**

`src/lib/concurrency.ts` :

```ts
/**
 * Concurrence bornée maison (zéro dépendance) pour l'orchestrateur.
 *
 * `pLimit(n)` : au plus `n` tâches en vol simultanément, résultats dans l'ordre
 * d'appel. `withTimeout` : borne la durée d'une tâche (une source qui hang ne
 * doit jamais bloquer tout le run).
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`délai dépassé après ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Borne le nombre de tâches concurrentes. Renvoie un wrapper `run(fn)`. */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = (): void => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const run = queue.shift()!;
    run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      };
      queue.push(run);
      next();
    });
}

/** Rejette avec `TimeoutError` si `promise` n'a pas résolu en `ms` ms. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
```

**Step 4 : Lancer pour voir passer**

Run: `npm test`
Expected: PASS.

**Step 5 : Commit**

```bash
git add src/lib/concurrency.ts src/lib/concurrency.test.ts
git commit -m "feat(lib): pLimit + withTimeout — concurrence bornée (zéro dépendance)"
```

---

## Task 4 : Étendre `FetchOptions` et `ScrapingSource`

**Files:**
- Modify: `src/lib/source-interface.ts`

**Step 1 : Ajouter `terms`, `boards` et `kind`**

Remplacer le contenu de `src/lib/source-interface.ts` par :

```ts
import type { RawJobOffer } from "./types";

export interface SearchFilters {
  keyword?: string;
  locations?: { label: string; radius: number | null }[];
  contractTypes?: string[];
  remotePreference?: "onsite" | "hybrid" | "remote" | "any";
}

export interface FetchOptions {
  limit?: number;
  maxPages?: number;
  filters?: SearchFilters;
  /**
   * Tous les termes de recherche du run. Les sources web bouclent dessus en
   * interne (un seul navigateur, hôte jamais frappé en parallèle) ; les sources
   * ATS s'en servent pour l'inclusion par titre (`matchesAnyTerm`).
   */
  terms?: string[];
  /** Boards à interroger (sources ATS uniquement) : tokens d'entreprise. */
  boards?: string[];
}

export interface ScrapingSource {
  name: string;
  /** "web" (scraping navigateur, défaut) ou "ats" (API JSON par board). */
  kind?: "web" | "ats";
  fetch(options?: FetchOptions): Promise<RawJobOffer[]>;
}
```

**Step 2 : Vérifier la compilation**

Run: `npm run typecheck`
Expected: PASS (les sources existantes restent compatibles : nouveaux champs optionnels).

**Step 3 : Commit**

```bash
git add src/lib/source-interface.ts
git commit -m "feat(sources): FetchOptions.terms/boards + ScrapingSource.kind"
```

---

## Task 5 : Source Greenhouse (mapper testé + fetch)

**Files:**
- Create: `src/sources/ats/greenhouse.ts`
- Test: `src/sources/ats/greenhouse.test.ts`

API : `GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=false`
→ `{ jobs: [{ title, company_name, location:{name}, absolute_url, first_published, updated_at }] }`.

**Step 1 : Écrire le test du mapper (échoue)**

`src/sources/ats/greenhouse.test.ts` :

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGreenhouseJob } from "./greenhouse";

const SAMPLE = {
  title: "Senior Data Engineer",
  company_name: "Stripe",
  location: { name: "Paris, France" },
  absolute_url: "https://stripe.com/jobs/search?gh_jid=123",
  first_published: "2026-06-02T11:35:23-04:00",
  updated_at: "2026-06-05T15:44:04-04:00",
};

test("mapGreenhouseJob : mappe vers RawScrapeResult", () => {
  assert.deepEqual(mapGreenhouseJob(SAMPLE), {
    title: "Senior Data Engineer",
    company: "Stripe",
    location: "Paris, France",
    salary: null,
    contractType: null,
    urlSource: "https://stripe.com/jobs/search?gh_jid=123",
    publishedRaw: "2026-06-02T11:35:23-04:00",
  });
});

test("mapGreenhouseJob : champs absents → null, fallback updated_at", () => {
  const r = mapGreenhouseJob({ title: "X", absolute_url: "u", updated_at: "2026-01-01T00:00:00Z" });
  assert.equal(r.company, null);
  assert.equal(r.location, null);
  assert.equal(r.publishedRaw, "2026-01-01T00:00:00Z");
});
```

**Step 2 : Lancer pour voir échouer**

Run: `npm test`
Expected: FAIL — module `./greenhouse` absent.

**Step 3 : Implémenter**

`src/sources/ats/greenhouse.ts` :

```ts
import type { RawJobOffer } from "../../lib/types";
import type { ScrapingSource, FetchOptions } from "../../lib/source-interface";
import type { RawScrapeResult } from "../../lib/parse-report";
import { ParseReport, finalizeOffers } from "../../lib/parse-report";
import { createLogger } from "../../lib/logger";
import { fetchJson, matchesAnyTerm } from "./shared";

const logger = createLogger("GREENHOUSE");

interface GreenhouseJob {
  title?: string;
  company_name?: string;
  location?: { name?: string };
  absolute_url?: string;
  first_published?: string;
  updated_at?: string;
}

/** Mappe une offre Greenhouse vers la forme brute commune `RawScrapeResult`. */
export function mapGreenhouseJob(job: GreenhouseJob): RawScrapeResult {
  return {
    title: job.title ?? "",
    company: job.company_name ?? null,
    location: job.location?.name ?? null,
    salary: null,
    contractType: null,
    urlSource: job.absolute_url ?? "",
    publishedRaw: job.first_published ?? job.updated_at ?? null,
  };
}

export const greenhouseSource: ScrapingSource = {
  name: "greenhouse",
  kind: "ats",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const boards = options?.boards ?? [];
    const terms = options?.terms ?? [];
    if (boards.length === 0 || terms.length === 0) return [];

    const report = new ParseReport("greenhouse");
    const all: RawJobOffer[] = [];
    const seen = new Set<string>();

    for (const board of boards) {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=false`;
      const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(url);
      if (!data?.jobs?.length) {
        logger.warn("Board sans offres ou injoignable", { board });
        continue;
      }

      const raws = data.jobs
        .map(mapGreenhouseJob)
        .filter((r) => r.title && r.urlSource && matchesAnyTerm(r.title, terms));

      report.addPageDiag({ cardCount: data.jobs.length, dropped: {} });
      for (const offer of finalizeOffers(raws, "greenhouse", report)) {
        if (!seen.has(offer.urlSource)) {
          seen.add(offer.urlSource);
          all.push(offer);
        }
      }
      logger.info("Board lu", { board, total: data.jobs.length, retenues: raws.length });
    }

    report.log(logger);
    return all;
  },
};
```

**Step 4 : Lancer pour voir passer**

Run: `npm test`
Expected: PASS.

**Step 5 : Commit**

```bash
git add src/sources/ats/greenhouse.ts src/sources/ats/greenhouse.test.ts
git commit -m "feat(ats): source Greenhouse (API JSON par board, inclusion par titre)"
```

---

## Task 6 : Source Lever (mapper testé + fetch)

**Files:**
- Create: `src/sources/ats/lever.ts`
- Test: `src/sources/ats/lever.test.ts`

API : `GET https://api.lever.co/v0/postings/{board}?mode=json` → tableau de postings
`{ text, categories:{location,commitment,team}, hostedUrl, createdAt(ms), descriptionPlain }`.
Board inexistant → `{ok:false}` (pas un tableau) ; board vide → `[]`.

**Step 1 : Écrire le test du mapper (échoue)**

`src/sources/ats/lever.test.ts` :

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLeverPosting } from "./lever";

test("mapLeverPosting : mappe vers RawScrapeResult (createdAt ms → ISO)", () => {
  const r = mapLeverPosting(
    {
      text: "Data Engineer",
      categories: { location: "Paris, France", commitment: "Permanent" },
      hostedUrl: "https://jobs.lever.co/swile/abc",
      createdAt: 1756369018244,
    },
    "swile",
  );
  assert.equal(r.title, "Data Engineer");
  assert.equal(r.company, "swile");
  assert.equal(r.location, "Paris, France");
  assert.equal(r.contractType, "Permanent");
  assert.equal(r.urlSource, "https://jobs.lever.co/swile/abc");
  assert.equal(r.publishedRaw, new Date(1756369018244).toISOString());
});

test("mapLeverPosting : champs absents → null", () => {
  const r = mapLeverPosting({ text: "X", hostedUrl: "u" }, "acme");
  assert.equal(r.location, null);
  assert.equal(r.contractType, null);
  assert.equal(r.publishedRaw, null);
});
```

**Step 2 : Lancer pour voir échouer**

Run: `npm test`
Expected: FAIL — module `./lever` absent.

**Step 3 : Implémenter**

`src/sources/ats/lever.ts` :

```ts
import type { RawJobOffer } from "../../lib/types";
import type { ScrapingSource, FetchOptions } from "../../lib/source-interface";
import type { RawScrapeResult } from "../../lib/parse-report";
import { ParseReport, finalizeOffers } from "../../lib/parse-report";
import { createLogger } from "../../lib/logger";
import { fetchJson, matchesAnyTerm } from "./shared";

const logger = createLogger("LEVER");

interface LeverPosting {
  text?: string;
  categories?: { location?: string; commitment?: string; team?: string };
  hostedUrl?: string;
  createdAt?: number;
}

/** Mappe un posting Lever vers `RawScrapeResult` (company = token du board). */
export function mapLeverPosting(posting: LeverPosting, board: string): RawScrapeResult {
  return {
    title: posting.text ?? "",
    company: board,
    location: posting.categories?.location ?? null,
    salary: null,
    contractType: posting.categories?.commitment ?? null,
    urlSource: posting.hostedUrl ?? "",
    publishedRaw: typeof posting.createdAt === "number"
      ? new Date(posting.createdAt).toISOString()
      : null,
  };
}

export const leverSource: ScrapingSource = {
  name: "lever",
  kind: "ats",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const boards = options?.boards ?? [];
    const terms = options?.terms ?? [];
    if (boards.length === 0 || terms.length === 0) return [];

    const report = new ParseReport("lever");
    const all: RawJobOffer[] = [];
    const seen = new Set<string>();

    for (const board of boards) {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`;
      const data = await fetchJson<LeverPosting[]>(url);
      if (!Array.isArray(data) || data.length === 0) {
        logger.warn("Board sans offres ou injoignable", { board });
        continue;
      }

      const raws = data
        .map((p) => mapLeverPosting(p, board))
        .filter((r) => r.title && r.urlSource && matchesAnyTerm(r.title, terms));

      report.addPageDiag({ cardCount: data.length, dropped: {} });
      for (const offer of finalizeOffers(raws, "lever", report)) {
        if (!seen.has(offer.urlSource)) {
          seen.add(offer.urlSource);
          all.push(offer);
        }
      }
      logger.info("Board lu", { board, total: data.length, retenues: raws.length });
    }

    report.log(logger);
    return all;
  },
};
```

**Step 4 : Lancer pour voir passer**

Run: `npm test`
Expected: PASS.

**Step 5 : Commit**

```bash
git add src/sources/ats/lever.ts src/sources/ats/lever.test.ts
git commit -m "feat(ats): source Lever (API JSON par board, inclusion par titre)"
```

---

## Task 7 : Enregistrer les sources ATS dans le registry

**Files:**
- Modify: `src/sources/registry.ts`

**Step 1 : Ajouter les imports et entrées**

Remplacer les lignes 1-13 de `src/sources/registry.ts` par :

```ts
import type { ScrapingSource } from "../lib/source-interface";
import { wttjSource } from "./wttj";
import { helloworkSource } from "./hellowork";
import { greenhouseSource } from "./ats/greenhouse";
import { leverSource } from "./ats/lever";

/**
 * Registry des sources. Ajouter une source = créer son fichier (interface
 * ScrapingSource) puis l'ajouter ici.
 *
 * - web : wttj, hellowork (scraping navigateur).
 * - ats : greenhouse, lever (API JSON ; boards éditables depuis l'UI via
 *   `settings.atsBoards`). Restent inertes tant qu'aucun board n'est configuré.
 *
 * À porter ensuite (best-effort) : indeed, linkedin, station-f.
 */
export const sources: ScrapingSource[] = [
  wttjSource,
  helloworkSource,
  greenhouseSource,
  leverSource,
];
```

**Step 2 : Vérifier la compilation**

Run: `npm run typecheck`
Expected: PASS.

**Step 3 : Commit**

```bash
git add src/sources/registry.ts
git commit -m "feat(sources): enregistrer greenhouse + lever dans le registry"
```

---

## Task 8 : `Settings.atsBoards` — types + persistance + validation API

**Files:**
- Modify: `src/shared/types.ts:47-51`
- Modify: `src/settings.ts`
- Modify: `src/server/routes/settings.ts`
- Modify: `docs/api-contract.md`

**Step 1 : Étendre le type `Settings`**

Dans `src/shared/types.ts`, remplacer l'interface `Settings` (lignes ~41-51) par :

```ts
/**
 * Configuration EFFECTIVE pilotée par l'UI (table sqlite `settings`).
 *
 * - `contractTypes` : valeurs possibles "stage" et "CDI".
 * - `enabledSources`: noms des sources actives (cf. registry des sources).
 * - `atsBoards`     : pour chaque source ATS (greenhouse, lever), la liste des
 *                     tokens d'entreprise à interroger. Ex. `{ greenhouse: ["stripe"] }`.
 */
export interface Settings {
  terms: string[];
  contractTypes: string[];
  enabledSources: string[];
  atsBoards: Record<string, string[]>;
}
```

**Step 2 : Persistance dans `src/settings.ts`**

- Ajouter la clé après les autres (ligne ~21) :

```ts
const KEY_ATS_BOARDS = "atsBoards";
```

- Ajouter un parseur de record après `parseList` :

```ts
function parseRecord(raw: string | undefined): Record<string, string[]> {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[k] = v.map((x) => String(x).trim()).filter((x) => x.length > 0);
      }
    }
    return out;
  } catch {
    return {};
  }
}
```

- Dans `seedValues()`, ajouter `atsBoards: {}` au retour.
- Dans `getSettings()`, ajouter au retour : `atsBoards: parseRecord(raw[KEY_ATS_BOARDS]),`
- Dans `setSettings()`, ajouter : `setSettingRaw(KEY_ATS_BOARDS, JSON.stringify(settings.atsBoards));`

**Step 3 : Validation serveur dans `src/server/routes/settings.ts`**

- Ajouter un validateur après `isStringArray` :

```ts
/** Vrai si `value` est un Record<string, string[]> (ou absent → {} en aval). */
function parseAtsBoards(value: unknown): Record<string, string[]> | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isStringArray(v)) return null;
    const seen = new Set<string>();
    out[k] = v.map((s) => s.trim()).filter((s) => s.length > 0 && !seen.has(s) && seen.add(s));
  }
  return out;
}
```

- Dans `parseSettingsBody`, après la validation de `enabledSources`, ajouter :

```ts
  const atsBoards = parseAtsBoards(candidate.atsBoards);
  if (atsBoards === null) return null;
```

- Ajouter `atsBoards,` à l'objet `Settings` retourné par `parseSettingsBody`.

**Step 4 : Documenter dans `docs/api-contract.md`**

Sous la section `GET /api/settings`, ajouter `atsBoards` à l'exemple JSON et une ligne le décrivant (Record de tokens par source ATS, optionnel en PUT → `{}` par défaut). Mettre à jour l'exemple de réponse pour inclure `"atsBoards": { "greenhouse": ["stripe"], "lever": ["swile"] }`.

**Step 5 : Vérifier compilation + tests**

Run: `npm run typecheck && npm test`
Expected: PASS. (Le typecheck signalera tout endroit construisant un `Settings` sans `atsBoards` — voir Task 10 pour le web.)

**Step 6 : Commit**

```bash
git add src/shared/types.ts src/settings.ts src/server/routes/settings.ts docs/api-contract.md
git commit -m "feat(settings): atsBoards (types + persistance sqlite + validation API + contrat)"
```

---

## Task 9 : Orchestrateur concurrent (une tâche par source)

**Files:**
- Modify: `src/index.ts`

**Step 1 : Remplacer `buildFilters` par une version sans keyword**

Remplacer la fonction `buildFilters` (lignes 35-46) par :

```ts
/** Filtres communs à toutes les sources web (le keyword est injecté par terme). */
function buildBaseFilters(contractTypes: string[]): SearchFilters {
  const cityLocations = (config.locations ?? [])
    .filter((l) => normalizeText(l) !== "remote")
    .map((label) => ({ label, radius: config.defaultRadiusKm ?? null }));

  return {
    locations: cityLocations.length ? cityLocations : undefined,
    contractTypes: contractTypes.length ? contractTypes : undefined,
    remotePreference: config.remote ?? "any",
  };
}
```

**Step 2 : Ajouter les imports en tête de fichier**

```ts
import { pLimit, withTimeout } from "./lib/concurrency";
```

Et une constante près de `const logger` :

```ts
/** Sources en parallèle (web = un seul navigateur/source, hôte jamais frappé 2× à la fois). */
const SOURCE_CONCURRENCY = 4;
/** Une source traite TOUS ses termes : timeout large. */
const SOURCE_TIMEOUT_MS = 240_000;
```

**Step 3 : Remplacer la double boucle `for term / for source` (lignes 79-129)**

Remplacer tout le bloc des deux boucles imbriquées par :

```ts
  const baseFilters = buildBaseFilters(settings.contractTypes);
  const limit = pLimit(SOURCE_CONCURRENCY);

  // Une tâche par source : la source boucle elle-même sur tous les termes.
  const tasks = activeSources.map((source) =>
    limit(async () => {
      const boards = settings.atsBoards?.[source.name] ?? [];
      let offers: Awaited<ReturnType<typeof source.fetch>> = [];
      try {
        offers = await withTimeout(
          source.fetch({
            terms: settings.terms,
            filters: baseFilters,
            boards,
            maxPages: config.maxPagesPerSource ?? 3,
          }),
          SOURCE_TIMEOUT_MS,
        );
      } catch (err) {
        logger.warn("Source ignorée (échec ou timeout)", {
          source: source.name,
          error: err instanceof Error ? err.message : String(err),
        });
        offers = [];
      }
      perSource[source.name] = offers.length;
      emit({ type: "progress", source: source.name, found: offers.length });
      return offers;
    }),
  );

  const offersBySource = await Promise.all(tasks);

  for (const offers of offersBySource) {
    found += offers.length;
    for (const offer of offers) {
      const hash = computeHash(offer);

      if (candidates.has(hash) || offerExists(hash)) {
        duplicates++;
        continue;
      }

      const verdict = passesFilters(offer, effectiveConfig);
      if (!verdict.passed) continue;

      newCount++;

      const { score, priority } = scoreOffer(offer, effectiveConfig);
      candidates.set(hash, { ...offer, hash, score, priority });

      if (dryRun) continue;

      insertOffer({
        hash,
        title: offer.title,
        company: offer.company,
        location: offer.location,
        url: offer.urlSource,
        source: offer.sourceName,
        score,
        publishedAt: offer.publishedAt ? offer.publishedAt.toISOString() : null,
      });
    }
  }
```

**Step 4 : Vérifier compilation**

Run: `npm run typecheck`
Expected: PASS.

**Step 5 : Dry-run réel (les sources ATS restent inertes sans boards configurés)**

Run: `npm run fetch:dry 2>&1 | tail -n 20`
Expected: le run se termine (`@@RUN {"type":"done"...}`), les sources tournent en parallèle, aucune erreur fatale. Les sources web peuvent renvoyer des offres ; greenhouse/lever renvoient 0 (pas de boards).

**Step 6 : Commit**

```bash
git add src/index.ts
git commit -m "feat(orchestrateur): concurrence bornée (une tâche/source) + timeout par source"
```

---

## Task 10 : Sources web — boucle de termes interne

**Files:**
- Modify: `src/sources/wttj.ts:157-235`
- Modify: `src/sources/hellowork.ts` (transformation analogue)

But : chaque source web boucle sur `options.terms` en interne, réutilise un seul navigateur, déduplique par URL à travers termes ET pages.

**Step 1 : Réécrire `wttjSource.fetch`**

Remplacer le corps de `fetch` (lignes 160-234) par :

```ts
  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;
    // Rétro-compat : si un appelant ne passe pas `terms`, retomber sur le keyword.
    const terms = options?.terms?.length
      ? options.terms
      : options?.filters?.keyword
        ? [options.filters.keyword]
        : [];
    if (terms.length === 0) return [];

    const browser = await launchBrowser();
    const report = new ParseReport("wttj");

    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        locale: "fr-FR",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const allOffers: RawJobOffer[] = [];
      const seen = new Set<string>();

      for (const term of terms) {
        const filters: SearchFilters = { ...options?.filters, keyword: term };

        for (let p = 1; p <= maxPages; p++) {
          const url = buildSearchUrl(p, filters);
          logger.info(`Scraping page ${p}`, { term, url });

          const { raws, diag } = await scrapePage(page, url);
          report.addPageDiag(diag);
          logger.debug(`Page ${p} lue`, { term, cartes: diag.cardCount, ignorees: diag.dropped });

          if (diag.cardCount === 0) {
            if (p === 1) {
              const artefacts = await captureFailure(page, "wttj", "zero-cards");
              logger.warn("0 carte sur la page 1 — sélecteur racine probablement cassé", {
                selector: CARD_SELECTOR,
                term,
                url,
                capture: artefacts ? `${artefacts}.html / .png` : "échec capture",
              });
            } else {
              logger.info(`Aucune offre page ${p}, arrêt pagination`, { term });
            }
            break;
          }

          const pageOffers = finalizeOffers(raws, "wttj", report);
          for (const offer of pageOffers) {
            if (!seen.has(offer.urlSource)) {
              seen.add(offer.urlSource);
              allOffers.push(offer);
            }
          }

          if (limit && allOffers.length >= limit) break;
          if (p < maxPages) await page.waitForTimeout(1500);
        }

        if (limit && allOffers.length >= limit) break;
        await page.waitForTimeout(1500); // délai poli entre deux termes
      }

      report.log(logger);
      const result = limit ? allOffers.slice(0, limit) : allOffers;
      logger.info(`${allOffers.length} offres uniques collectées, ${result.length} renvoyées`);
      return result;
    } catch (error) {
      logger.error("Source en échec", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      await browser.close();
    }
  },
```

**Step 2 : Appliquer la MÊME transformation à `src/sources/hellowork.ts`**

Lire `src/sources/hellowork.ts`. Sa structure `fetch` est jumelle de wttj. Appliquer exactement le même patron :
1. Dériver `terms` en tête (même bloc rétro-compat + `if (terms.length === 0) return []`).
2. Englober la boucle de pages `for (let p = 1; …)` existante dans `for (const term of terms) { … }`.
3. Construire `filters` par terme : `const filters: SearchFilters = { ...options?.filters, keyword: term };` et l'utiliser dans son `buildSearchUrl`.
4. Garder `allOffers`, `seen`, `report` déclarés AVANT la boucle de termes (accumulation à travers les termes).
5. Ajouter `await page.waitForTimeout(1500)` entre deux termes.
6. Importer `SearchFilters` depuis `../lib/source-interface` si pas déjà importé.

**Step 3 : Vérifier compilation**

Run: `npm run typecheck`
Expected: PASS.

**Step 4 : Dry-run réel (vérifier que les sources web ramènent toujours des offres)**

Run: `npm run fetch:dry 2>&1 | tail -n 30`
Expected: `@@RUN` de progression par source (wttj, hellowork, greenhouse, lever), terminaison propre, et au moins une source web qui collecte > 0 offre (selon disponibilité réseau/anti-bot — best-effort).

**Step 5 : Commit**

```bash
git add src/sources/wttj.ts src/sources/hellowork.ts
git commit -m "refactor(sources web): boucle de termes interne (1 tâche/source, 1 navigateur)"
```

---

## Task 11 : UI Paramètres — éditeur de boards ATS

**Files:**
- Modify: `web/lib/api-client.ts:66-70` (MOCK_SETTINGS)
- Modify: `web/pages/Settings.tsx`

**Step 1 : Compléter le mock**

Dans `web/lib/api-client.ts`, ajouter `atsBoards` à `MOCK_SETTINGS` :

```ts
const MOCK_SETTINGS: Settings = {
  terms: ["data engineer", "machine learning engineer"],
  contractTypes: ["CDI"],
  enabledSources: ["wttj", "hellowork"],
  atsBoards: { greenhouse: ["stripe"], lever: ["swile"] },
};
```

**Step 2 : Déclarer les sources ATS dans le catalogue (Settings.tsx)**

Remplacer `KNOWN_SOURCES` (lignes 43-46) par une version typée avec `ats` :

```ts
const KNOWN_SOURCES: { name: string; label: string; ats?: boolean }[] = [
  { name: "wttj", label: "Welcome to the Jungle" },
  { name: "hellowork", label: "HelloWork" },
  { name: "greenhouse", label: "Greenhouse (pages carrières)", ats: true },
  { name: "lever", label: "Lever (pages carrières)", ats: true },
];
```

**Step 3 : Garantir `atsBoards` non-undefined au chargement**

Dans le `useEffect` de chargement, là où l'on fait `setSettings({ ...s, terms: dedupeTerms(s.terms) })`, ajouter un repli :
`setSettings({ ...s, terms: dedupeTerms(s.terms), atsBoards: s.atsBoards ?? {} })`.

**Step 4 : Ajouter les handlers de boards** (près de `toggleSource`)

```ts
function addBoard(source: string, raw: string): void {
  if (!settings) return;
  const token = raw.trim();
  if (!token) return;
  const current = settings.atsBoards[source] ?? [];
  if (current.some((b) => b.toLowerCase() === token.toLowerCase())) return;
  patch({ ...settings, atsBoards: { ...settings.atsBoards, [source]: [...current, token] } });
}

function removeBoard(source: string, index: number): void {
  if (!settings) return;
  const current = settings.atsBoards[source] ?? [];
  patch({
    ...settings,
    atsBoards: { ...settings.atsBoards, [source]: current.filter((_, i) => i !== index) },
  });
}
```

**Step 5 : Rendre l'éditeur sous chaque source ATS activée**

Dans la carte « Sources », pour chaque `src` du `sourceCatalog` qui est ATS (`KNOWN_SOURCES.find(k => k.name === src.name)?.ats`) ET activée (`settings.enabledSources.includes(src.name)`), afficher sous la `ToggleRow` un sous-bloc d'édition réutilisant EXACTEMENT le pattern des chips de termes (lignes 272-312) : liste `settings.atsBoards[src.name]` en chips mono avec bouton supprimer (`aria-label={`Retirer le board « ${board} »`}`), + un petit `<form>` (`Input` + `Button variant="signal" size="sm"`) qui appelle `addBoard(src.name, value)`.

Contraintes design system (NON négociables) :
- Tokens/couleurs via variables CSS (aucun hex/px en dur), primitives `Input`/`Button`/`Badge` uniquement.
- Données (tokens de board) en `font-[family-name:var(--font-mono)]`.
- Icônes `lucide` décoratives → `aria-hidden="true"` ; bouton-icône → `aria-label`.
- Champ d'ajout : `aria-label={`Ajouter un board ${src.label}`}` ; placeholder `ex. stripe`.
- Le sous-bloc est rattaché au groupe via `role="group"` + `aria-label`.

Conserver la barre de sauvegarde existante : `save()` envoie déjà tout l'objet `settings` (atsBoards inclus).

**Step 6 : Vérifier le typecheck web + build**

Run: `npm run typecheck:web && npm run build`
Expected: PASS (build Vite OK).

**Step 7 : Vérification visuelle (manuelle)**

Run: `npm start` puis ouvrir `http://127.0.0.1:<port>` → page Paramètres.
Vérifier : activer « Greenhouse » fait apparaître l'éditeur de boards ; ajouter `stripe`, enregistrer, recharger → le board persiste. (Voir skill `verify` / `run` au besoin.)

**Step 8 : Commit**

```bash
git add web/lib/api-client.ts web/pages/Settings.tsx
git commit -m "feat(ui): éditeur de boards ATS dans la page Paramètres (design system)"
```

---

## Task 12 : Vérification de bout en bout

**Files:** aucun (validation).

**Step 1 : Suite de tests complète**

Run: `npm test`
Expected: PASS (shared, concurrency, greenhouse, lever).

**Step 2 : Typecheck src + web**

Run: `npm run typecheck && npm run typecheck:web`
Expected: PASS.

**Step 3 : Run réel avec un board configuré**

Configurer un board (via l'UI ou en seedant) puis :
Run: `npm run fetch 2>&1 | tail -n 30`
Expected : progression par source en parallèle ; greenhouse/lever ramènent des offres dont le titre matche un terme ; ligne `runs` écrite ; terminaison propre.

**Step 4 : Vérifier l'absence de régression de durée**

Comparer la durée du run (log `Résumé`/`runs.durationMs`) : doit être ≤ à l'ancien run séquentiel équivalent.

**Step 5 : Commit final / récap**

```bash
git add -A
git commit -m "test(e2e): vérification ATS + orchestrateur concurrent" --allow-empty
```

---

## Notes d'implémentation

- **Zéro nouvelle dépendance** : `fetch` natif, `node:test`, `pLimit` maison.
- **`passesFilters` (filter.ts) reste intouché** : l'inclusion par terme est dans la source ATS (`matchesAnyTerm`), c'est une recherche, pas un filtre métier.
- **Best-effort strict conservé** : board injoignable → skip ; source en échec/timeout → `[]` ; le run ne casse jamais.
- **Anti-bot** : le modèle « une tâche/source » garantit qu'un même hôte n'est jamais frappé en parallèle (les termes sont bouclés en série dans le même navigateur).
- **Logos** : `public/logos/greenhouse.svg` / `lever.svg` sont optionnels — `SourceLogo` retombe sur un monogramme. À ajouter plus tard (YAGNI).
- **Hors périmètre** : Indeed, LinkedIn, Station F, autres ATS, filtrage sur description, pilotage UI du timeout/concurrence.
