import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions, SearchFilters } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult, PageDiag } from "../lib/parse-report";
import { captureFailure } from "../lib/debug-capture";
import {
  WTTJ_UA,
  WTTJ_LOCALE,
  WTTJ_VIEWPORT,
  WTTJ_STORAGE_PATH,
  wttjStorageStateIfPresent,
} from "./wttj-session";

const logger = createLogger("WTTJ");
const BASE_URL = "https://www.welcometothejungle.com";
// La recherche publique « classique » de WTTJ a été remplacée par un flux de
// matching qui pousse vers la création de compte (`/fr/jobs?query=…` ne rend
// plus de liste). Le paramètre `classic-search=1` sur `/fr/jobs-matches`
// rétablit la liste de résultats consultable sans authentification.
const SEARCH_PATH = "/fr/jobs-matches";

// Conteneur d'une offre : `data-testid="job-card-<n>"`. Les éléments internes
// (tags, boutons) portent des testid `job-card-tag-…` / `job-card-…` : on filtre
// donc sur le motif exact `job-card-<nombre>` pour ne garder que les cartes.
const CARD_SELECTOR = '[data-testid^="job-card-"]';

function buildSearchUrl(page: number, filters?: SearchFilters): string {
  const params = new URLSearchParams();
  params.set("classic-search", "1");

  if (filters?.keyword) {
    params.set("q", filters.keyword);
  }

  // WTTJ classic-search ne prend qu'une ville. Les autres critères (contrat,
  // remote, salaire) sont volontairement laissés au filtre déterministe en aval
  // (`src/filter.ts`) : les anciens paramètres Algolia `refinementList[…]` ne
  // sont plus reconnus par cette page.
  if (filters?.locations?.length) {
    params.set("city", filters.locations[0]!.label);
  }

  params.set("page", String(page));

  return `${BASE_URL}${SEARCH_PATH}?${params.toString()}`;
}

/** Résultat brut d'une page + diagnostic (cartes vues / ignorées). */
interface ScrapePageResult {
  raws: RawScrapeResult[];
  diag: PageDiag;
  /** `true` si WTTJ a redirigé vers la page de connexion (session expirée/invalide). */
  redirectedToAuth: boolean;
}

async function scrapePage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>,
  url: string,
): Promise<ScrapePageResult> {
  // `domcontentloaded` (et non `networkidle`) : l'app WTTJ (Next.js) maintient
  // des requêtes en fond, `networkidle` peut ne jamais être atteint et faire
  // timeout le goto. On charge vite puis on attend explicitement les cartes,
  // ce qui laisse le temps de rendu côté client au sélecteur ci-dessous.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Session absente/expirée → WTTJ redirige vers /fr/authenticate/signin. On le
  // détecte tôt pour émettre un message d'auth ciblé (et NE PAS capturer la page
  // de login comme un faux « sélecteur cassé »).
  if (page.url().includes("/authenticate/")) {
    return { raws: [], diag: { cardCount: 0, dropped: { noTitle: 0, noHref: 0 } }, redirectedToAuth: true };
  }

  const cardsAppeared = await page
    .waitForSelector('[data-testid="job-card-1"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!cardsAppeared) {
    logger.warn("Sélecteur de cartes absent après attente", { selector: CARD_SELECTOR, url });
  }

  // Le parsing se fait DANS le contexte navigateur, au plus près du DOM, puis
  // remonte sous forme de diagnostic structuré.
  //
  // NB : tout est inliné (aucune fonction nommée imbriquée). tsx/esbuild enrobe
  // sinon les fonctions nommées d'un appel `__name(...)` absent du contexte
  // navigateur, ce qui fait planter `page.evaluate` (`__name is not defined`).
  const { raws, cardCount, dropped } = await page.evaluate(
    ({ baseUrl, cardSelector }) => {
      const results: RawScrapeResult[] = [];
      const dropped = { noTitle: 0, noHref: 0 };

      // On ne garde que les vraies cartes `job-card-<nombre>` (les tags internes
      // partagent le préfixe `job-card-`).
      const cards = [...document.querySelectorAll(cardSelector)].filter((c) =>
        /^job-card-\d+$/.test(c.getAttribute("data-testid") ?? ""),
      );

      // La date est un nœud texte (« 21 mai 2026 » ou « il y a 6 heures ») niché
      // dans un div aux classes utilitaires instables, SANS testid. Motifs assez
      // stricts pour ne pas confondre avec « … € par mois » (salaire).
      const reAbs =
        /\b\d{1,2}\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|janv|févr|fevr|juil|sept|oct|nov|déc|dec)\.?\s+(?:19|20)\d{2}\b/i;
      const reRel = /il y a\s+\d+\s*(?:heure|jour|semaine|mois|an)|aujourd|hier/i;

      for (const card of cards) {
        const el = card as HTMLElement;

        // Le lien titre pointe vers une offre ; il contient le titre (texte
        // direct) ET l'entreprise (dans un <p>). On isole le titre en retirant le
        // <p> sur un clone.
        const titleAnchor = el.querySelector("a[href*='/jobs/']");
        const href = titleAnchor?.getAttribute("href");
        if (!href) {
          dropped.noHref++;
          continue;
        }

        const company = titleAnchor?.querySelector("p")?.textContent?.trim() || null;

        let title = "";
        if (titleAnchor) {
          const clone = titleAnchor.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("p").forEach((p) => p.remove());
          title = clone.textContent?.trim() ?? "";
        }
        if (!title) {
          dropped.noTitle++;
          continue;
        }

        const contractType =
          el.querySelector('[data-testid="job-card-tag-contract-type"]')?.textContent?.trim() ||
          null;
        const location =
          el.querySelector('[data-testid="job-card-tag-location"]')?.textContent?.trim() || null;
        const salary =
          el.querySelector('[data-testid="job-card-tag-salary"]')?.textContent?.trim() || null;

        let publishedRaw: string | null = null;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const t = (node.textContent ?? "").trim();
          if (!t) continue;
          if (reAbs.test(t) || reRel.test(t)) {
            publishedRaw = t;
            break;
          }
        }

        results.push({
          title,
          company,
          location,
          salary,
          contractType,
          urlSource: href.startsWith("http") ? href : `${baseUrl}${href}`,
          publishedRaw,
        });
      }

      return { raws: results, cardCount: cards.length, dropped };
    },
    { baseUrl: BASE_URL, cardSelector: CARD_SELECTOR },
  );

  return { raws, diag: { cardCount, dropped }, redirectedToAuth: false };
}

export const wttjSource: ScrapingSource = {
  name: "wttj",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;
    // Rétro-compat : si l'appelant ne passe pas `terms`, retomber sur le keyword.
    const terms = options?.terms?.length
      ? options.terms
      : options?.filters?.keyword
        ? [options.filters.keyword]
        : [];
    if (terms.length === 0) return [];

    // WTTJ a verrouillé sa recherche par mot-clé derrière l'authentification.
    // Sans session exportée, on ne lance même pas le navigateur : on loggue une
    // consigne actionnable et on rend [] (best-effort, ne casse pas le run).
    const storageState = wttjStorageStateIfPresent();
    if (!storageState) {
      logger.warn(
        "Session WTTJ absente : la recherche par mot-clé exige une connexion. " +
          "Lance `npm run wttj:login` (connexion manuelle, une seule fois).",
        { attendu: WTTJ_STORAGE_PATH },
      );
      return [];
    }

    const browser = await launchBrowser();
    // Abort de l'orchestrateur (timeout/échec) : on ferme le navigateur sans
    // attendre la résolution de la promesse de fetch (les opérations Playwright
    // en cours lèveront → catch → []). Le `finally` ci-dessous reste : le double
    // close Playwright est sans danger.
    options?.signal?.addEventListener("abort", () => {
      browser.close().catch(() => {});
    });
    const report = new ParseReport("wttj");

    try {
      const context = await browser.newContext({
        storageState,
        userAgent: WTTJ_UA,
        locale: WTTJ_LOCALE,
        viewport: { ...WTTJ_VIEWPORT },
      });
      const page = await context.newPage();
      const allOffers: RawJobOffer[] = [];
      const seen = new Set<string>();

      termsLoop: for (const term of terms) {
        const filters: SearchFilters = { ...options?.filters, keyword: term };

        for (let p = 1; p <= maxPages; p++) {
          const url = buildSearchUrl(p, filters);
          logger.info(`Scraping page ${p}`, { term, url });

          const { raws, diag, redirectedToAuth } = await scrapePage(page, url);

          if (redirectedToAuth) {
            logger.warn(
              "Redirigé vers la page de connexion : session WTTJ expirée ou invalide. " +
                "Relance `npm run wttj:login` pour la régénérer.",
              { storageState: WTTJ_STORAGE_PATH },
            );
            break termsLoop;
          }

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
            break; // boucle de pages seulement → terme suivant
          }

          const pageOffers = finalizeOffers(raws, "wttj", report);
          for (const offer of pageOffers) {
            if (!seen.has(offer.urlSource)) {
              seen.add(offer.urlSource);
              allOffers.push(offer);
            }
          }

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
