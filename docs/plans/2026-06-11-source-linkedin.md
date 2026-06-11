# Source LinkedIn (endpoint guest) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ajouter une source `linkedin` à l'agrégateur qui récupère des offres via l'endpoint guest non authentifié de LinkedIn, en best-effort, dans le respect des conventions du projet.

**Architecture:** Source `kind: "web"` calquée sur `src/sources/wttj.ts` mais **sans bloc auth** : `launchBrowser()` + stealth charge le fragment HTML de l'endpoint guest (`/jobs-guest/jobs/api/seeMoreJobPostings/search`), parsing par `page.evaluate`, boucle de termes interne (un seul navigateur), pagination par `start`, dédup par URL, abort sur signal, `ParseReport`/`finalizeOffers`/`captureFailure`. Deux helpers purs (`buildGuestSearchUrl`, `cleanJobUrl`) sont extraits et testés.

**Tech Stack:** Node + TypeScript, Playwright (`launchBrowser`), `node:test`/`node:assert` via tsx.

**Design de référence :** `docs/plans/2026-06-11-source-linkedin-design.md`

---

### Task 1 : Helpers purs + tests (`buildGuestSearchUrl`, `cleanJobUrl`)

On commence par la logique pure et testable (TDD). Ces deux fonctions vivent en
haut de `src/sources/linkedin.ts` et sont exportées (named export) pour le test.

**Files:**
- Create: `src/sources/linkedin.test.ts`
- Create: `src/sources/linkedin.ts` (partiel — uniquement les 2 helpers + constantes pour cette task)

**Step 1 : Écrire le test qui échoue**

Créer `src/sources/linkedin.test.ts` :

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuestSearchUrl, cleanJobUrl } from "./linkedin";

test("buildGuestSearchUrl : encode keyword + location + start", () => {
  const url = buildGuestSearchUrl("data engineer", "Paris", 0);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
  assert.equal(u.searchParams.get("keywords"), "data engineer");
  assert.equal(u.searchParams.get("location"), "Paris");
  assert.equal(u.searchParams.get("start"), "0");
});

test("buildGuestSearchUrl : start incrémenté présent dans l'URL", () => {
  const url = buildGuestSearchUrl("ml engineer", "Paris", 25);
  assert.equal(new URL(url).searchParams.get("start"), "25");
});

test("buildGuestSearchUrl : location vide → paramètre location omis", () => {
  const url = buildGuestSearchUrl("data engineer", "", 0);
  assert.equal(new URL(url).searchParams.has("location"), false);
});

test("cleanJobUrl : strip des paramètres de tracking", () => {
  const dirty =
    "https://www.linkedin.com/jobs/view/data-engineer-at-acme-123456789?refId=abc&trackingId=xyz&position=1";
  assert.equal(cleanJobUrl(dirty), "https://www.linkedin.com/jobs/view/data-engineer-at-acme-123456789");
});

test("cleanJobUrl : URL déjà propre est inchangée", () => {
  const clean = "https://www.linkedin.com/jobs/view/data-engineer-at-acme-123456789";
  assert.equal(cleanJobUrl(clean), clean);
});

test("cleanJobUrl : href relatif est préfixé par l'origine LinkedIn", () => {
  assert.equal(
    cleanJobUrl("/jobs/view/123456789?refId=abc"),
    "https://www.linkedin.com/jobs/view/123456789",
  );
});

test("cleanJobUrl : href invalide → chaîne d'origine (best-effort)", () => {
  assert.equal(cleanJobUrl(""), "");
});
```

**Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `npm test -- --test-name-pattern="buildGuestSearchUrl|cleanJobUrl"`
(ou simplement `npm test`)
Expected: FAIL — `Cannot find module './linkedin'` (le fichier n'existe pas encore).

**Step 3 : Écrire l'implémentation minimale des helpers**

Créer `src/sources/linkedin.ts` avec, en tête de fichier, les constantes et les
deux helpers purs :

```ts
import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions, SearchFilters } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult, PageDiag } from "../lib/parse-report";
import { captureFailure } from "../lib/debug-capture";

const logger = createLogger("LINKEDIN");

const ORIGIN = "https://www.linkedin.com";
// Endpoint guest : rend un fragment HTML de cartes d'offres, paginé par `start`.
// Non authentifié, mais rate-limité (429/999 si frappé trop vite).
const GUEST_SEARCH_PATH = "/jobs-guest/jobs/api/seeMoreJobPostings/search";

// Conteneur d'une offre dans le fragment guest.
const CARD_SELECTOR = "div.base-card";

/**
 * Construit l'URL de l'endpoint guest pour un terme, une ville et un offset.
 * `location` vide ⇒ paramètre omis (recherche mondiale). Fonction pure.
 */
export function buildGuestSearchUrl(term: string, location: string, start: number): string {
  const params = new URLSearchParams();
  params.set("keywords", term);
  if (location) params.set("location", location);
  params.set("start", String(start));
  return `${ORIGIN}${GUEST_SEARCH_PATH}?${params.toString()}`;
}

/**
 * Nettoie une URL d'offre : retire les paramètres de tracking (refId, trackingId…)
 * pour obtenir l'URL canonique `…/jobs/view/<id>`. Préfixe les href relatifs par
 * l'origine LinkedIn. Best-effort : un href invalide est renvoyé tel quel.
 * Fonction pure.
 */
export function cleanJobUrl(href: string): string {
  if (!href) return href;
  try {
    const u = new URL(href, ORIGIN);
    return `${u.origin}${u.pathname}`;
  } catch {
    return href;
  }
}
```

**Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `npm test -- --test-name-pattern="buildGuestSearchUrl|cleanJobUrl"`
Expected: PASS (7 tests).

**Step 5 : Typecheck**

Run: `npm run typecheck`
Expected: pas d'erreur (les imports non encore utilisés de Task 2 ne sont PAS
présents à ce stade — n'ajouter que les imports réellement consommés ; si
`npm run typecheck` signale un import inutilisé, le retirer temporairement et le
remettre en Task 2).

> Note : pour éviter le va-et-vient, on peut n'importer en Step 3 que
> `URLSearchParams`/`URL` (globaux, aucun import) ; les imports Playwright/parse
> ne sont ajoutés qu'en Task 2. Garder le fichier minimal ici.

**Step 6 : Commit**

```bash
git add src/sources/linkedin.ts src/sources/linkedin.test.ts
git commit -m "feat(linkedin): helpers purs buildGuestSearchUrl + cleanJobUrl (testés)"
```

---

### Task 2 : Corps de la source (`linkedinSource`)

On ajoute la fonction `fetch` complète. Pas de test unitaire (parsing
browser-bound, comme WTTJ) ; la validation se fait par typecheck + run manuel en
Task 4.

**Files:**
- Modify: `src/sources/linkedin.ts` (ajouter le scrapePage + l'objet `linkedinSource`)

**Step 1 : Ajouter le scraping d'une page**

Après les helpers, ajouter (calqué sur `wttj.ts:scrapePage`, parsing inliné dans
`page.evaluate` — AUCUNE fonction nommée imbriquée, sinon `__name is not defined`
dans le contexte navigateur) :

```ts
interface ScrapePageResult {
  raws: RawScrapeResult[];
  diag: PageDiag;
}

async function scrapePage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>,
  url: string,
): Promise<ScrapePageResult> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // L'endpoint rend un fragment statique : les cartes sont présentes au
  // domcontentloaded. On tente une courte attente du sélecteur, sans bloquer.
  await page
    .waitForSelector(CARD_SELECTOR, { timeout: 8_000 })
    .catch(() => false);

  const { raws, cardCount, dropped } = await page.evaluate(
    ({ origin, cardSelector }) => {
      const results: RawScrapeResult[] = [];
      const dropped = { noTitle: 0, noHref: 0 };

      const cards = [...document.querySelectorAll(cardSelector)];

      for (const card of cards) {
        const el = card as HTMLElement;

        const link =
          el.querySelector("a.base-card__full-link") ||
          el.querySelector("a[href*='/jobs/view/']");
        const rawHref = link?.getAttribute("href");
        if (!rawHref) {
          dropped.noHref++;
          continue;
        }
        // Nettoyage URL inliné (cleanJobUrl n'est pas disponible dans le contexte
        // navigateur) : strip query/fragment, préfixe origine si relatif.
        let urlSource = rawHref;
        try {
          const u = new URL(rawHref, origin);
          urlSource = `${u.origin}${u.pathname}`;
        } catch {
          // href inexploitable : on garde rawHref tel quel.
        }

        const title = el.querySelector(".base-search-card__title")?.textContent?.trim() ?? "";
        if (!title) {
          dropped.noTitle++;
          continue;
        }

        const company =
          el.querySelector(".base-search-card__subtitle")?.textContent?.trim() || null;
        const location =
          el.querySelector(".job-search-card__location")?.textContent?.trim() || null;

        const timeEl = el.querySelector("time");
        const publishedRaw =
          timeEl?.getAttribute("datetime") || timeEl?.textContent?.trim() || null;

        results.push({
          title,
          company,
          location,
          salary: null,
          contractType: null,
          urlSource,
          publishedRaw,
        });
      }

      return { raws: results, cardCount: cards.length, dropped };
    },
    { origin: ORIGIN, cardSelector: CARD_SELECTOR },
  );

  return { raws, diag: { cardCount, dropped } };
}
```

**Step 2 : Ajouter l'objet `linkedinSource`**

À la suite (calqué sur `wttj.ts` : boucle de termes interne, dédup par URL,
abort, pagination par `start` incrémenté du nombre de cartes vues) :

```ts
export const linkedinSource: ScrapingSource = {
  name: "linkedin",
  kind: "web",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;
    const terms = options?.terms?.length
      ? options.terms
      : options?.filters?.keyword
        ? [options.filters.keyword]
        : [];
    if (terms.length === 0) return [];

    // Une seule ville (comme WTTJ) ; le reste du filtrage est en aval.
    const location = options?.filters?.locations?.[0]?.label ?? "";

    const browser = await launchBrowser();
    options?.signal?.addEventListener("abort", () => {
      browser.close().catch(() => {});
    });
    const report = new ParseReport("linkedin");

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const allOffers: RawJobOffer[] = [];
      const seen = new Set<string>();

      termsLoop: for (const term of terms) {
        let start = 0;

        for (let p = 1; p <= maxPages; p++) {
          const url = buildGuestSearchUrl(term, location, start);
          logger.info(`Scraping page ${p}`, { term, url });

          const { raws, diag } = await scrapePage(page, url);
          report.addPageDiag(diag);
          logger.debug(`Page ${p} lue`, { term, cartes: diag.cardCount, ignorees: diag.dropped });

          if (diag.cardCount === 0) {
            if (p === 1) {
              const artefacts = await captureFailure(page, "linkedin", "zero-cards");
              logger.warn("0 carte sur la page 1 — sélecteur cassé ou rate-limit LinkedIn", {
                selector: CARD_SELECTOR,
                term,
                url,
                capture: artefacts ? `${artefacts}.html / .png` : "échec capture",
              });
            } else {
              logger.info(`Aucune offre page ${p}, arrêt pagination`, { term });
            }
            break; // boucle de pages seulement → terme suivant
          }

          const pageOffers = finalizeOffers(raws, "linkedin", report);
          for (const offer of pageOffers) {
            if (!seen.has(offer.urlSource)) {
              seen.add(offer.urlSource);
              allOffers.push(offer);
            }
          }

          // `start` incrémenté du nombre de cartes réellement renvoyées : l'endpoint
          // guest en rend un nombre variable, ce qui évite chevauchements et trous.
          start += diag.cardCount;

          if (limit && allOffers.length >= limit) break termsLoop;
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
};
```

**Step 3 : Typecheck**

Run: `npm run typecheck`
Expected: pas d'erreur. Vérifier que `SearchFilters` est bien importé (utilisé via
`options.filters`) — si TS signale un import inutilisé, ajuster la ligne d'import.

**Step 4 : Re-lancer les tests (non-régression)**

Run: `npm test`
Expected: PASS (les 7 tests de Task 1 + le reste de la suite).

**Step 5 : Commit**

```bash
git add src/sources/linkedin.ts
git commit -m "feat(linkedin): source guest complète (scrape, pagination start, abort, ParseReport)"
```

---

### Task 3 : Câblage registry + catalogue UI + logo

**Files:**
- Modify: `src/sources/registry.ts`
- Modify: `web/pages/Settings.tsx:43-47` (tableau `KNOWN_SOURCES`)
- Create: `public/logos/linkedin.svg`

**Step 1 : Enregistrer la source dans le registry**

Dans `src/sources/registry.ts` :
- Ajouter l'import : `import { linkedinSource } from "./linkedin";`
- Ajouter `linkedinSource` au tableau `sources` (après `helloworkSource`, avant les ATS — l'ordre est conservé) :

```ts
export const sources: ScrapingSource[] = [
  wttjSource,
  helloworkSource,
  linkedinSource,
  greenhouseSource,
  leverSource,
];
```
- Mettre à jour le commentaire « À porter ensuite (best-effort) : indeed, linkedin, station-f. » → retirer `linkedin`.

**Step 2 : Ajouter au catalogue UI**

Dans `web/pages/Settings.tsx`, tableau `KNOWN_SOURCES`, ajouter après hellowork :

```ts
  { name: "linkedin", label: "LinkedIn" },
```

**Step 3 : Créer le logo officiel**

Créer `public/logos/linkedin.svg` (« in » blanc sur carré bleu `#0A66C2`, même
viewBox carré 0 0 64 64 que les autres logos pour un rendu net à 24–32px) :

```svg
<!-- Logo de la source "linkedin". Glyphe officiel : carré bleu LinkedIn (#0A66C2)
     + "in" blanc. viewBox carré pour un rendu net à 24-32px. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="32" height="32" role="img" aria-label="LinkedIn">
  <rect width="64" height="64" rx="14" fill="#0A66C2"/>
  <g fill="#ffffff">
    <circle cx="20" cy="19" r="4.2"/>
    <rect x="16.3" y="26" width="7.4" height="22"/>
    <path d="M30 26h7.1v3.1h.1c1-1.8 3.4-3.7 7-3.7 7.5 0 8.9 4.7 8.9 10.9V48h-7.4V37.8c0-2.6 0-5.9-3.7-5.9-3.7 0-4.3 2.8-4.3 5.7V48H30z"/>
  </g>
</svg>
```

**Step 4 : Typecheck web**

Run: `npm run typecheck:web`
Expected: pas d'erreur.

**Step 5 : Commit**

```bash
git add src/sources/registry.ts web/pages/Settings.tsx public/logos/linkedin.svg
git commit -m "feat(linkedin): câblage registry + catalogue Paramètres + logo"
```

---

### Task 4 : Vérification manuelle de bout en bout (dry-run)

Pas de code : on valide que la source rend des offres et que l'instrumentation
fonctionne. Best-effort — si LinkedIn rate-limite (0 carte + WARN + capture),
c'est un résultat **acceptable** (le run va jusqu'à `done`), pas un échec du code.

**Step 1 : Activer temporairement la source pour le test**

LinkedIn n'est pas activée par défaut. Pour ce test, soit la cocher dans l'UI
Paramètres, soit lancer un run en sachant qu'elle est inactive. Le plus simple
sans toucher la base : un petit script ad hoc qui appelle directement la source.

Run (sonde isolée, ne touche pas la base) :
```bash
npx tsx -e "import('./src/sources/linkedin.ts').then(async ({ linkedinSource }) => {
  const offers = await linkedinSource.fetch({
    terms: ['data engineer'],
    filters: { locations: [{ label: 'Paris', radius: 30 }] },
    maxPages: 1,
  });
  console.log('OFFRES:', offers.length);
  console.log(offers.slice(0, 3));
})"
```
Expected (cas nominal) : `OFFRES: N` avec N > 0, et des objets ayant `title`,
`company`, `location`, `urlSource` (propre, sans `?refId=`), `publishedAt` (Date).
Sur stderr : le « Bilan parsing » du `ParseReport`.

Expected (cas rate-limit, acceptable) : `OFFRES: 0` + WARN « 0 carte … rate-limit »
+ artefacts sous `data/debug/linkedin-zero-cards-*.{html,png}`. Si c'est le cas,
ouvrir le `.html` capturé pour confirmer que c'est bien un blocage (et non un
sélecteur cassé) avant de conclure.

**Step 2 : Vérifier le remplissage des champs**

Dans la sortie, contrôler que `company`, `location`, `publishedAt` ne sont pas
`null` à 100 % (sinon le `ParseReport` aura levé un WARN « sélecteur probablement
cassé » → ajuster le sélecteur concerné dans `scrapePage`).

**Step 3 : Run intégré via l'orchestrateur (optionnel)**

Cocher LinkedIn dans l'UI Paramètres (`npm start`, page Paramètres) puis lancer un
run depuis l'UI, ou `npm run fetch:dry`. Vérifier dans les logs la ligne
`progress` pour `source: "linkedin"`.

**Step 4 : Nettoyer**

Aucun commit (pas de modif de code). Si la source a été cochée dans l'UI pour le
test et qu'on ne veut pas la laisser active, la décocher.

---

## Récapitulatif des commits

1. `feat(linkedin): helpers purs buildGuestSearchUrl + cleanJobUrl (testés)`
2. `feat(linkedin): source guest complète (scrape, pagination start, abort, ParseReport)`
3. `feat(linkedin): câblage registry + catalogue Paramètres + logo`

(Task 4 ne produit pas de commit.)

## Points de vigilance

- **`page.evaluate` : tout inliné.** Aucune fonction nommée imbriquée dans le
  callback (tsx/esbuild les enrobe d'un `__name(...)` absent du contexte
  navigateur → `__name is not defined`). `cleanJobUrl` est donc ré-inliné dans le
  callback, et testé séparément côté Node.
- **Rate-limit = best-effort.** 0 carte n'est pas un bug du code : le run continue.
  La capture post-mortem permet de distinguer blocage vs sélecteur cassé.
- **Pas de salaire / contrat** dans le guest : `null` assumé, filtre lenient en aval.
- **`f_TPR`, `geoId`, etc.** hors périmètre (YAGNI) : keyword + location suffisent.
