import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions, SearchFilters } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { parsePublishedAt } from "../lib/dates";

const logger = createLogger("HELLOWORK");
const BASE_URL = "https://www.hellowork.com";
const SEARCH_PATH = "/fr-fr/emploi/recherche.html";

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

async function scrapePage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>,
  url: string,
): Promise<RawJobOffer[]> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

  // Bannière cookies éventuelle
  const cookieBtn = await page.$('button:has-text("Accepter"), button:has-text("Tout accepter")');
  if (cookieBtn) {
    await cookieBtn.click();
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector('[data-cy="serpCard"]', { timeout: 15_000 }).catch(() => {
    logger.warn("No offer cards found after waiting");
  });

  const offers = await page.evaluate((baseUrl: string) => {
    const results: {
      title: string;
      company: string | null;
      location: string | null;
      salary: string | null;
      contractType: string | null;
      urlSource: string;
      publishedRaw: string | null;
    }[] = [];

    const cards = document.querySelectorAll('[data-cy="serpCard"]');

    for (const card of cards) {
      const el = card as HTMLElement;

      const titleEl = el.querySelector('[data-cy="offerTitle"] h3 p:first-child');
      const title = titleEl?.textContent?.trim() ?? "";
      if (!title) continue;

      const companyEl = el.querySelector('[data-cy="offerTitle"] h3 p:nth-child(2)');
      const company = companyEl?.textContent?.trim() ?? null;

      const href = el.querySelector('[data-cy="offerTitle"]')?.getAttribute("href");
      if (!href) continue;

      const location = el.querySelector('[data-cy="localisationCard"]')?.textContent?.trim() ?? null;
      const contractType = el.querySelector('[data-cy="contractCard"]')?.textContent?.trim() ?? null;

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

    return results;
  }, BASE_URL);

  return offers.map((o: typeof offers[number]) => {
    const { publishedRaw, ...rest } = o;
    return {
      ...rest,
      sourceName: "hellowork" as const,
      publishedAt: parsePublishedAt(publishedRaw),
    };
  });
}

export const helloworkSource: ScrapingSource = {
  name: "hellowork",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;
    const browser = await launchBrowser();

    try {
      const page = await browser.newPage();
      const allOffers: RawJobOffer[] = [];

      for (let p = 1; p <= maxPages; p++) {
        const url = buildSearchUrl(p, options?.filters);
        logger.info(`Scraping page ${p}`, { url });

        const pageOffers = await scrapePage(page, url);

        if (pageOffers.length === 0) {
          logger.info(`No offers on page ${p}, stopping pagination`);
          break;
        }

        allOffers.push(...pageOffers);

        if (limit && allOffers.length >= limit) break;

        if (p < maxPages) {
          await page.waitForTimeout(1500);
        }
      }

      const result = limit ? allOffers.slice(0, limit) : allOffers;
      logger.info(`Collected ${allOffers.length} offers, returning ${result.length}`);
      return result;
    } catch (error) {
      logger.error("Source failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    } finally {
      await browser.close();
    }
  },
};
