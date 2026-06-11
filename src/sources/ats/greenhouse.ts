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
      if (options?.signal?.aborted) break;
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
