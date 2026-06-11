import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult } from "../lib/parse-report";
import {
  WTTJ_UA,
  WTTJ_LOCALE,
  WTTJ_VIEWPORT,
  WTTJ_STORAGE_PATH,
  wttjStorageStateIfPresent,
} from "./wttj-session";

const logger = createLogger("WTTJ");
const SITE_URL = "https://www.welcometothejungle.com";
// API JSON authentifiée. Connecté, WTTJ ignore tout mot-clé d'URL et sert le
// *feed personnalisé* de l'utilisateur (ses recherches sauvegardées) : cet
// endpoint le renvoie proprement, paginé, sans scraping DOM ni override de
// rendu. Il n'accepte QUE `page` / `per_page` — aucun filtre serveur. La
// pertinence est donc pilotée côté WTTJ (recherches sauvegardées du compte), et
// affinée ensuite par notre filtre déterministe (exclude/salaryMin/locations/
// contractTypes).
const API_URL = "https://api.welcometothejungle.com/api/v3/search/jobs";
const PER_PAGE = 30;

/** contract_type WTTJ (API, en anglais) → libellé FR (cohérent avec l'UI / le filtre). */
const CONTRACT_MAP: Record<string, string> = {
  permanent: "CDI",
  full_time: "CDI",
  fixed_term: "CDD",
  temporary: "CDD",
  internship: "Stage",
  apprenticeship: "Alternance",
  freelance: "Freelance",
  vie: "VIE",
  part_time: "Temps partiel",
};

/** Forme (partielle) d'une offre telle que renvoyée par l'API v3. */
interface ApiJob {
  name?: string;
  slug?: string;
  organization?: { name?: string; slug?: string };
  office?: { city?: string | null };
  offices?: Array<{ city?: string | null }>;
  contract_type?: string;
  published_at?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  salary_period?: string | null;
}

interface ApiResponse {
  data?: ApiJob[];
  metadata?: { total?: number; page?: number; per_page?: number; page_count?: number };
}

/** Construit un libellé de salaire parsable par `parseSalary` (gère mensuel/annuel). */
function buildSalary(j: ApiJob): string | null {
  const { salary_min: min, salary_max: max } = j;
  if (min == null && max == null) return null;
  const cur = j.salary_currency ?? "EUR";
  const amount = min != null && max != null && max !== min ? `${min} - ${max}` : `${min ?? max}`;
  const period =
    j.salary_period === "monthly" ? " par mois" : j.salary_period === "yearly" ? " par an" : "";
  return `${amount} ${cur}${period}`;
}

/** Mappe une offre API → RawScrapeResult (publishedRaw = ISO, parsé en aval). */
function toRaw(j: ApiJob): RawScrapeResult | null {
  const title = j.name?.trim();
  const orgSlug = j.organization?.slug;
  if (!title || !j.slug || !orgSlug) return null; // sans URL fiable, on ignore

  const rawContract = j.contract_type ?? null;
  const contractType = rawContract ? (CONTRACT_MAP[rawContract] ?? rawContract) : null;
  const location = j.office?.city ?? j.offices?.find((o) => o.city)?.city ?? null;

  return {
    title,
    company: j.organization?.name?.trim() || null,
    location: location || null,
    salary: buildSalary(j),
    contractType,
    urlSource: `${SITE_URL}/fr/companies/${orgSlug}/jobs/${j.slug}`,
    publishedRaw: j.published_at ?? null,
  };
}

export const wttjSource: ScrapingSource = {
  name: "wttj",

  async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
    const maxPages = options?.maxPages ?? 3;
    const limit = options?.limit;

    // WTTJ exige une session authentifiée (cf. wttj-session.ts). Sans elle, on
    // n'ouvre même pas le navigateur : consigne actionnable + [] (best-effort).
    const storageState = wttjStorageStateIfPresent();
    if (!storageState) {
      logger.warn(
        "Session WTTJ absente : l'API exige une connexion. " +
          "Lance `npm run wttj:login` (connexion manuelle, une seule fois).",
        { attendu: WTTJ_STORAGE_PATH },
      );
      return [];
    }

    const browser = await launchBrowser();
    options?.signal?.addEventListener("abort", () => {
      browser.close().catch(() => {});
    });
    const report = new ParseReport("wttj");

    try {
      // Contexte authentifié : `context.request` réutilise les cookies de session
      // (domaine `.welcometothejungle.com`, donc valides sur le sous-domaine API).
      // Aucune page n'est chargée : on tape directement l'API JSON.
      const context = await browser.newContext({
        storageState,
        userAgent: WTTJ_UA,
        locale: WTTJ_LOCALE,
        viewport: { ...WTTJ_VIEWPORT },
      });

      logger.info("Feed personnalisé WTTJ (API) — les mots-clés de config ne s'appliquent pas", {
        note: "pertinence pilotée par les recherches sauvegardées du compte",
      });

      const allOffers: RawJobOffer[] = [];
      const seen = new Set<string>();

      for (let p = 1; p <= maxPages; p++) {
        const res = await context.request.get(`${API_URL}?page=${p}&per_page=${PER_PAGE}`, {
          headers: {
            Accept: "application/json",
            Referer: `${SITE_URL}/`,
            Origin: SITE_URL,
          },
        });

        if (res.status() === 401 || res.status() === 403) {
          logger.warn(
            "API WTTJ : 401/403 — session expirée ou invalide. " +
              "Relance `npm run wttj:login` pour la régénérer.",
            { storageState: WTTJ_STORAGE_PATH, status: res.status() },
          );
          break;
        }
        if (!res.ok()) {
          logger.warn("API WTTJ : réponse inattendue", { status: res.status(), page: p });
          break;
        }

        const body = (await res.json().catch(() => null)) as ApiResponse | null;
        const jobs = body?.data ?? [];
        const pageCount = body?.metadata?.page_count ?? null;
        logger.info(`Page ${p}`, { offres: jobs.length, total: body?.metadata?.total ?? "?" });

        if (jobs.length === 0) {
          if (p === 1) {
            logger.warn("Feed WTTJ vide en page 1", {
              hint: "as-tu des recherches sauvegardées sur WTTJ ? (le feed en dépend)",
            });
          }
          break;
        }

        // Map → RawScrapeResult ; les offres sans URL fiable (org/slug manquant)
        // sont comptées comme « ignorées » dans le diagnostic.
        const raws: RawScrapeResult[] = [];
        let dropped = 0;
        for (const j of jobs) {
          const raw = toRaw(j);
          if (raw) raws.push(raw);
          else dropped++;
        }
        report.addPageDiag({ cardCount: jobs.length, dropped: { noUrl: dropped } });

        const pageOffers = finalizeOffers(raws, "wttj", report);
        for (const offer of pageOffers) {
          if (!seen.has(offer.urlSource)) {
            seen.add(offer.urlSource);
            allOffers.push(offer);
          }
        }

        if (limit && allOffers.length >= limit) break;
        if (pageCount != null && p >= pageCount) break; // dernière page atteinte
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
