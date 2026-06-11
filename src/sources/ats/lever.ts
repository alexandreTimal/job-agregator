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
