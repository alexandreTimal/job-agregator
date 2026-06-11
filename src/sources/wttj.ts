import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions, SearchFilters } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { parsePublishedAt } from "../lib/dates";

const logger = createLogger("WTTJ");
const BASE_URL = "https://www.welcometothejungle.com";
const SEARCH_PATH = "/fr/jobs";

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

async function scrapePage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>,
  url: string,
): Promise<RawJobOffer[]> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

  await page.waitForSelector('[data-role="jobs:thumb"]', { timeout: 15_000 }).catch(() => {
    logger.warn("No job cards found after waiting");
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

    const cards = document.querySelectorAll('[data-role="jobs:thumb"]');

    for (const card of cards) {
      const el = card as HTMLElement;

      const title = el.querySelector("h2")?.textContent?.trim() ?? "";
      if (!title) continue;

      const href = el.querySelector("a[href*='/jobs/']")?.getAttribute("href");
      if (!href) continue;

      const company = el.querySelector('[data-testid^="job-thumb-logo-"]')
        ?.closest("div")?.parentElement
        ?.querySelector("span")?.textContent?.trim() ?? null;

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

    return results;
  }, BASE_URL);

  return offers.map((o: typeof offers[number]) => {
    const { publishedRaw, ...rest } = o;
    return {
      ...rest,
      sourceName: "wttj" as const,
      publishedAt: parsePublishedAt(publishedRaw),
    };
  });
}

export const wttjSource: ScrapingSource = {
  name: "wttj",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;
    const browser = await launchBrowser();

    try {
      const page = await browser.newPage();
      const allOffers: RawJobOffer[] = [];
      const seen = new Set<string>();

      for (let p = 1; p <= maxPages; p++) {
        const url = buildSearchUrl(p, options?.filters);
        logger.info(`Scraping page ${p}`, { url });

        const pageOffers = await scrapePage(page, url);

        if (pageOffers.length === 0) {
          logger.info(`No offers on page ${p}, stopping pagination`);
          break;
        }

        // Deduplicate by URL within this run
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

      const result = limit ? allOffers.slice(0, limit) : allOffers;
      logger.info(`Collected ${allOffers.length} unique offers, returning ${result.length}`);
      return result;
    } catch (error) {
      logger.error("Source failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    } finally {
      await browser.close();
    }
  },
};
