import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions, SearchFilters } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult, PageDiag } from "../lib/parse-report";
import { captureFailure } from "../lib/debug-capture";

const logger = createLogger("WTTJ");
const BASE_URL = "https://www.welcometothejungle.com";
const SEARCH_PATH = "/fr/jobs";
const CARD_SELECTOR = '[data-role="jobs:thumb"]';

const CONTRACT_MAP: Record<string, string> = {
  cdi: "CDI",
  cdd: "CDD / Temporaire",
  interim: "CDD / Temporaire",
  "intérim": "CDD / Temporaire",
  stage: "Stage",
  alternance: "Alternance",
  freelance: "Freelance",
  vie: "VIE",
};

const REMOTE_MAP: Record<string, string[]> = {
  remote: ["fulltime"],
  hybrid: ["partial", "hybrid"],
  onsite: [],
  any: [],
};

function buildSearchUrl(page: number, filters?: SearchFilters): string {
  const params = new URLSearchParams();

  if (filters?.keyword) {
    params.set("query", filters.keyword);
  }

  if (filters?.contractTypes?.length) {
    for (const ct of filters.contractTypes) {
      const mapped = CONTRACT_MAP[ct.toLowerCase()] ?? ct;
      params.append("refinementList[contract_type_names.fr][]", mapped);
    }
  }

  if (filters?.remotePreference && filters.remotePreference !== "any") {
    const remoteValues = REMOTE_MAP[filters.remotePreference] ?? [];
    for (const val of remoteValues) {
      params.append("refinementList[remote][]", val);
    }
  }

  params.set("page", String(page));

  return `${BASE_URL}${SEARCH_PATH}?${params.toString()}`;
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
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

  const cardsAppeared = await page
    .waitForSelector(CARD_SELECTOR, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!cardsAppeared) {
    logger.warn("Sélecteur de cartes absent après attente", { selector: CARD_SELECTOR, url });
  }

  // Le comptage des cartes et des rejets se fait DANS le contexte navigateur,
  // au plus près du DOM, puis remonte sous forme de diagnostic structuré.
  const { raws, cardCount, dropped } = await page.evaluate(
    ({ baseUrl, cardSelector }) => {
      const results: RawScrapeResult[] = [];
      const dropped = { noTitle: 0, noHref: 0 };

      const cards = document.querySelectorAll(cardSelector);

      for (const card of cards) {
        const el = card as HTMLElement;

        const title = el.querySelector("h2")?.textContent?.trim() ?? "";
        if (!title) {
          dropped.noTitle++;
          continue;
        }

        const href = el.querySelector("a[href*='/jobs/']")?.getAttribute("href");
        if (!href) {
          dropped.noHref++;
          continue;
        }

        const company =
          el
            .querySelector('[data-testid^="job-thumb-logo-"]')
            ?.closest("div")?.parentElement?.querySelector("span")
            ?.textContent?.trim() ?? null;

        let contractType: string | null = null;
        let location: string | null = null;

        const metaDivs = el.querySelectorAll("svg[alt]");
        for (const svg of metaDivs) {
          const alt = svg.getAttribute("alt");
          const text = svg.closest("div")?.textContent?.trim() ?? "";
          if (alt === "Contract" && text) contractType = text;
          if (alt === "Location" && text) location = text;
        }

        // Date de publication best-effort : on privilégie l'attribut
        // `datetime` d'un éventuel <time>, sinon le texte affiché.
        // NB : un `datetime` présent mais vide ("") est traité comme absent
        // pour ne pas court-circuiter le repli sur le texte.
        const timeEl = el.querySelector("time");
        const publishedRaw =
          (timeEl?.getAttribute("datetime")?.trim() || null) ??
          timeEl?.textContent?.trim() ??
          null;

        results.push({
          title,
          company,
          location,
          salary: null,
          contractType,
          urlSource: href.startsWith("http") ? href : `${baseUrl}${href}`,
          publishedRaw,
        });
      }

      return { raws: results, cardCount: cards.length, dropped };
    },
    { baseUrl: BASE_URL, cardSelector: CARD_SELECTOR },
  );

  return { raws, diag: { cardCount, dropped } };
}

export const wttjSource: ScrapingSource = {
  name: "wttj",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;
    const browser = await launchBrowser();
    const report = new ParseReport("wttj");

    try {
      const page = await browser.newPage();
      const allOffers: RawJobOffer[] = [];
      const seen = new Set<string>();

      for (let p = 1; p <= maxPages; p++) {
        const url = buildSearchUrl(p, options?.filters);
        logger.info(`Scraping page ${p}`, { url });

        const { raws, diag } = await scrapePage(page, url);
        report.addPageDiag(diag);
        logger.debug(`Page ${p} lue`, { cartes: diag.cardCount, ignorees: diag.dropped });

        if (diag.cardCount === 0) {
          // 0 carte sur la 1re page = anomalie forte (≠ « plus de résultats » en
          // pagination profonde) : on fige la page pour pouvoir re-dériver le sélecteur.
          if (p === 1) {
            const artefacts = await captureFailure(page, "wttj", "zero-cards");
            logger.warn("0 carte sur la page 1 — sélecteur racine probablement cassé", {
              selector: CARD_SELECTOR,
              url,
              capture: artefacts ? `${artefacts}.html / .png` : "échec capture",
            });
          } else {
            logger.info(`Aucune offre page ${p}, arrêt pagination`);
          }
          break;
        }

        const pageOffers = finalizeOffers(raws, "wttj", report);

        // Déduplication par URL au sein de ce run.
        for (const offer of pageOffers) {
          if (!seen.has(offer.urlSource)) {
            seen.add(offer.urlSource);
            allOffers.push(offer);
          }
        }

        if (limit && allOffers.length >= limit) break;

        if (p < maxPages) {
          await page.waitForTimeout(1500);
        }
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
