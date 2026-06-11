import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions } from "../lib/source-interface";
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
 * Nettoie une URL d'offre : ne conserve que `origin + path` (l'id de l'offre vit
 * dans le path, `…/jobs/view/<id>`), écartant query/fragment de tracking. Préfixe
 * les href relatifs par l'origine LinkedIn. Best-effort : un href invalide est
 * renvoyé tel quel. Fonction pure.
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

/** Résultat brut d'une page + diagnostic (cartes vues / ignorées). */
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

  // Le parsing se fait DANS le contexte navigateur, au plus près du DOM, puis
  // remonte sous forme de diagnostic structuré.
  //
  // NB : tout est inliné (aucune fonction nommée imbriquée). tsx/esbuild enrobe
  // sinon les fonctions nommées d'un appel `__name(...)` absent du contexte
  // navigateur, ce qui fait planter `page.evaluate` (`__name is not defined`) —
  // c'est pourquoi le nettoyage d'URL est ré-inliné ici plutôt que d'appeler
  // `cleanJobUrl`.
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
