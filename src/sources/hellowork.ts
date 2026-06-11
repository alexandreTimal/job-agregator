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
  // `domcontentloaded` (et non `networkidle`) : sur un site JS lourd avec polling
  // analytics, `networkidle` n'est jamais atteint et le goto timeout à 30 s. On
  // charge vite puis on attend explicitement le sélecteur de cartes plus bas.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Bannière cookies éventuelle : clic best-effort à TIMEOUT COURT. Le bouton
  // peut exister dans le DOM sans être cliquable (caché, dans une iframe de
  // consentement) ; un clic sans timeout bloquerait 30 s et planterait toute la
  // source. On ne doit jamais laisser le consentement casser le scrape.
  const cookieBtn = await page.$('button:has-text("Accepter"), button:has-text("Tout accepter")');
  if (cookieBtn) {
    await cookieBtn.click({ timeout: 3000 }).catch(() => {
      logger.debug("Clic bannière cookies ignoré (bouton non cliquable)");
    });
    await page.waitForTimeout(500);
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
          // HelloWork n'expose ni <time> ni [data-cy="publicationDate"] : la date
          // est un simple texte (« il y a 1 heure », « aujourd'hui », « hier »…)
          // niché dans un élément générique. On scanne tous les descendants et on
          // retient le texte le PLUS COURT qui matche un motif de date relative,
          // pour éviter d'attraper celui d'un parent (« Voir l'offre il y a 1 h »).
          let best: string | null = null;
          for (const node of el.querySelectorAll("span, div, p, li")) {
            const t = node.textContent?.trim() ?? "";
            if (t.length > 0 && t.length <= 30 && /il y a|aujourd|hier/i.test(t)) {
              if (best === null || t.length < best.length) best = t;
            }
          }
          publishedRaw = best;
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
    // Rétro-compat : si l'appelant ne passe pas `terms`, retomber sur le keyword.
    const terms = options?.terms?.length
      ? options.terms
      : options?.filters?.keyword
        ? [options.filters.keyword]
        : [];
    if (terms.length === 0) return [];

    const browser = await launchBrowser();
    // Abort de l'orchestrateur (timeout/échec) : on ferme le navigateur sans
    // attendre la résolution de la promesse de fetch (les opérations Playwright
    // en cours lèveront → catch → []). Le `finally` ci-dessous reste : le double
    // close Playwright est sans danger.
    options?.signal?.addEventListener("abort", () => {
      browser.close().catch(() => {});
    });
    const report = new ParseReport("hellowork");

    try {
      const page = await browser.newPage();
      const allOffers: RawJobOffer[] = [];
      const seen = new Set<string>();

      termsLoop: for (const term of terms) {
        const filters: SearchFilters = { ...options?.filters, keyword: term };

        for (let p = 1; p <= maxPages; p++) {
          const url = buildSearchUrl(p, filters);
          logger.info(`Scraping page ${p}`, { term, url });

          const { raws, diag } = await scrapePage(page, url);
          report.addPageDiag(diag);
          logger.debug(`Page ${p} lue`, { term, cartes: diag.cardCount, ignorees: diag.dropped });

          if (diag.cardCount === 0) {
            // 0 carte sur la 1re page = anomalie forte : on fige la page pour debug.
            if (p === 1) {
              const artefacts = await captureFailure(page, "hellowork", "zero-cards");
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

          const pageOffers = finalizeOffers(raws, "hellowork", report);
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
