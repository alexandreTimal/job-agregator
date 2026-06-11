import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions, SearchFilters } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult, PageDiag } from "../lib/parse-report";
import { captureFailure } from "../lib/debug-capture";

const logger = createLogger("HELLOWORK");
const BASE_URL = "https://www.hellowork.com";
const SEARCH_PATH = "/fr-fr/emploi/recherche.html";
const CARD_SELECTOR = '[data-cy="serpCard"]';

const CONTRACT_MAP: Record<string, string> = {
  cdi: "CDI",
  cdd: "CDD",
  interim: "Interim",
  "intérim": "Interim",
  stage: "Stage",
  alternance: "Alternance",
  freelance: "Freelance",
  independant: "Independant",
  "indépendant": "Independant",
};

function buildSearchUrl(page: number, filters?: SearchFilters): string {
  const params = new URLSearchParams();

  if (filters?.keyword) {
    params.set("k", filters.keyword);
  }

  if (filters?.locations?.length) {
    // HelloWork ne supporte qu'une localisation
    params.set("l", filters.locations[0]!.label);
    const radius = filters.locations[0]!.radius;
    if (radius) {
      params.set("ray", String(radius));
    }
  }

  if (filters?.contractTypes?.length) {
    for (const ct of filters.contractTypes) {
      const mapped = CONTRACT_MAP[ct.toLowerCase()] ?? ct;
      params.append("c", mapped);
    }
  }

  params.set("d", "all");
  params.set("st", "date");
  params.set("p", String(page));

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

  // Bannière cookies éventuelle
  const cookieBtn = await page.$('button:has-text("Accepter"), button:has-text("Tout accepter")');
  if (cookieBtn) {
    await cookieBtn.click();
    await page.waitForTimeout(1000);
  }

  const cardsAppeared = await page
    .waitForSelector(CARD_SELECTOR, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!cardsAppeared) {
    logger.warn("Sélecteur de cartes absent après attente", { selector: CARD_SELECTOR, url });
  }

  const { raws, cardCount, dropped } = await page.evaluate(
    ({ baseUrl, cardSelector }) => {
      const results: RawScrapeResult[] = [];
      const dropped = { noTitle: 0, noHref: 0 };

      const cards = document.querySelectorAll(cardSelector);

      for (const card of cards) {
        const el = card as HTMLElement;

        const titleEl = el.querySelector('[data-cy="offerTitle"] h3 p:first-child');
        const title = titleEl?.textContent?.trim() ?? "";
        if (!title) {
          dropped.noTitle++;
          continue;
        }

        const href = el.querySelector('[data-cy="offerTitle"]')?.getAttribute("href");
        if (!href) {
          dropped.noHref++;
          continue;
        }

        const companyEl = el.querySelector('[data-cy="offerTitle"] h3 p:nth-child(2)');
        const company = companyEl?.textContent?.trim() ?? null;

        const location =
          el.querySelector('[data-cy="localisationCard"]')?.textContent?.trim() ?? null;
        const contractType =
          el.querySelector('[data-cy="contractCard"]')?.textContent?.trim() ?? null;

        let salary: string | null = null;
        const tags = el.querySelectorAll(".tw-tag-secondary-s");
        for (const tag of tags) {
          const text = tag.textContent?.trim() ?? "";
          if (text.includes("€")) {
            salary = text;
            break;
          }
        }

        // Date de publication best-effort : attribut `datetime` d'un <time>
        // si présent, sinon le texte d'un éventuel libellé de date relative.
        // NB : un `datetime` présent mais vide ("") est traité comme absent
        // pour ne pas court-circuiter le repli sur [data-cy=publicationDate].
        const timeEl = el.querySelector("time");
        let publishedRaw: string | null =
          (timeEl?.getAttribute("datetime")?.trim() || null) ??
          timeEl?.textContent?.trim() ??
          el.querySelector('[data-cy="publicationDate"]')?.textContent?.trim() ??
          null;

        if (!publishedRaw) {
          // Repli : repérer un tag du type « il y a … » / « aujourd'hui » / « hier ».
          const dateTags = el.querySelectorAll(".tw-tag-contract-s, .tw-tag-secondary-s, time, span");
          for (const tag of dateTags) {
            const t = tag.textContent?.trim() ?? "";
            if (/il y a|aujourd|hier/i.test(t)) {
              publishedRaw = t;
              break;
            }
          }
        }

        results.push({
          title,
          company: company || null,
          location: location || null,
          salary: salary || null,
          contractType: contractType || null,
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

export const helloworkSource: ScrapingSource = {
  name: "hellowork",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;
    const browser = await launchBrowser();
    const report = new ParseReport("hellowork");

    try {
      const page = await browser.newPage();
      const allOffers: RawJobOffer[] = [];

      for (let p = 1; p <= maxPages; p++) {
        const url = buildSearchUrl(p, options?.filters);
        logger.info(`Scraping page ${p}`, { url });

        const { raws, diag } = await scrapePage(page, url);
        report.addPageDiag(diag);
        logger.debug(`Page ${p} lue`, { cartes: diag.cardCount, ignorees: diag.dropped });

        if (diag.cardCount === 0) {
          // 0 carte sur la 1re page = anomalie forte : on fige la page pour debug.
          if (p === 1) {
            const artefacts = await captureFailure(page, "hellowork", "zero-cards");
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

        const pageOffers = finalizeOffers(raws, "hellowork", report);
        allOffers.push(...pageOffers);

        if (limit && allOffers.length >= limit) break;

        if (p < maxPages) {
          await page.waitForTimeout(1500);
        }
      }

      report.log(logger);

      const result = limit ? allOffers.slice(0, limit) : allOffers;
      logger.info(`${allOffers.length} offres collectées, ${result.length} renvoyées`);
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
