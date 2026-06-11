import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions } from "../lib/source-interface";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult, PageDiag } from "../lib/parse-report";
import { captureFailure } from "../lib/debug-capture";

const logger = createLogger("JOBTEASER");
const BASE_URL = "https://www.jobteaser.com";
const SEARCH_PATH = "/fr/job-offers";
const CARD_SELECTOR = '[data-testid="jobad-card"]';

/**
 * Lien d'une VRAIE offre : `/{lang}/job-offers/<uuid>-<slug>`. Sert à écarter les
 * cartes sponsorisées « Campagne de recrutement » (qui pointent vers
 * `/companies/.../newsfeed/...`) et l'URL de recherche nue (`/fr/job-offers` sans
 * segment). On exige le code langue + le segment qui démarre par un début d'UUID
 * (8 hexa). Le `flags`/`source` est repassé à `page.evaluate` pour éviter toute
 * dérive entre le filtre exécuté en page et celui testé unitairement.
 */
const OFFER_HREF_RE = /\/[a-z]{2}\/job-offers\/[0-9a-f]{8}/i;

/** JobTeaser n'expose que `q` (mot-clé) et `page` côté URL ; lieu/contrat = Algolia client. */
export function buildSearchUrl(term: string, page: number): string {
  const params = new URLSearchParams();
  params.set("q", term);
  if (page > 1) params.set("page", String(page));
  return `${BASE_URL}${SEARCH_PATH}?${params.toString()}`;
}

/** Fonction pure : un href est-il une offre réelle (et non une carte sponsorisée) ? */
export function isJobOfferHref(href: string | null | undefined): boolean {
  return !!href && OFFER_HREF_RE.test(href);
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
  // `domcontentloaded` (pas `networkidle`) : SSR Next.js, les cartes sont dans le
  // HTML initial ; on attend ensuite explicitement le sélecteur de cartes.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Bannière cookies best-effort à TIMEOUT COURT : ne JAMAIS laisser le
  // consentement bloquer le scrape (cf. convention HelloWork).
  const cookieBtn = await page.$(
    'button:has-text("Tout accepter"), button:has-text("Accepter"), #onetrust-accept-btn-handler',
  );
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
    ({ baseUrl, cardSelector, hrefSource, hrefFlags }) => {
      const offerHrefRe = new RegExp(hrefSource, hrefFlags);
      const results: RawScrapeResult[] = [];
      const dropped = { noOfferLink: 0, noTitle: 0 };

      const cards = document.querySelectorAll(cardSelector);

      for (const card of cards) {
        const el = card as HTMLElement;

        // Le lien d'offre : <a> dont le href matche une offre réelle. Les cartes
        // sponsorisées (« Campagne de recrutement ») n'en ont aucun → écartées.
        // Une carte peut porter PLUSIEURS liens vers la même offre (logo sans
        // texte + titre) : on retient celui au texte le plus long = le titre,
        // pour ne pas hériter d'un libellé vide selon l'ordre du DOM.
        let anchor: HTMLAnchorElement | null = null;
        let anchorText = "";
        for (const a of el.querySelectorAll("a[href]")) {
          const href = a.getAttribute("href");
          if (!href || !offerHrefRe.test(href)) continue;
          const text = (a.textContent ?? "").trim();
          if (anchor === null || text.length > anchorText.length) {
            anchor = a as HTMLAnchorElement;
            anchorText = text;
          }
        }
        if (!anchor) {
          dropped.noOfferLink++;
          continue;
        }

        const href = anchor.getAttribute("href")!;
        const title = anchorText;
        if (!title) {
          dropped.noTitle++;
          continue;
        }

        const company =
          el.querySelector('[data-testid="jobad-card-company-name"]')?.textContent?.trim() ?? null;
        const location =
          el.querySelector('[data-testid="jobad-card-location"]')?.textContent?.trim() ?? null;
        const contractType =
          el.querySelector('[data-testid="jobad-card-contract"]')?.textContent?.trim() ?? null;

        // Date de publication : attribut <time datetime> si présent, sinon le
        // TEXTE du <time> (date absolue type « 21 mai 2026 », gérée par
        // parsePublishedAt), sinon en dernier repli le texte relatif le PLUS
        // COURT matchant un motif de date (« il y a 2 heures », « hier »,
        // « avant-hier »…), pour ne pas attraper le texte d'un parent.
        const timeEl = el.querySelector("time");
        let publishedRaw: string | null =
          (timeEl?.getAttribute("datetime")?.trim() || null) ??
          (timeEl?.textContent?.trim() || null);
        if (!publishedRaw) {
          let best: string | null = null;
          for (const node of el.querySelectorAll("time, span, div, p, li")) {
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
          salary: null,
          contractType: contractType || null,
          urlSource: href.startsWith("http") ? href : `${baseUrl}${href}`,
          publishedRaw,
        });
      }

      return { raws: results, cardCount: cards.length, dropped };
    },
    {
      baseUrl: BASE_URL,
      cardSelector: CARD_SELECTOR,
      hrefSource: OFFER_HREF_RE.source,
      hrefFlags: OFFER_HREF_RE.flags,
    },
  );

  return { raws, diag: { cardCount, dropped } };
}

export const jobteaserSource: ScrapingSource = {
  name: "jobteaser",
  kind: "web",

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
    // Abort orchestrateur (timeout/échec) : fermer le navigateur sans attendre la
    // résolution de la promesse de fetch (les opérations en cours lèveront → catch).
    options?.signal?.addEventListener("abort", () => {
      browser.close().catch(() => {});
    });
    const report = new ParseReport("jobteaser");

    // Hoistés hors du `try` pour SURVIVRE au `catch` : à l'abort ou au crash, on
    // restitue les offres déjà collectées au lieu de tout jeter.
    const allOffers: RawJobOffer[] = [];
    const seen = new Set<string>();

    try {
      const page = await browser.newPage();

      // Pas de `locationSlots` : JobTeaser n'a aucun paramètre d'URL lieu/contrat
      // (filtres Algolia côté client). On boucle seulement termes × pages, un seul
      // navigateur (hôte jamais frappé en parallèle).
      searchLoop: for (const [i, term] of terms.entries()) {
        options?.onProgress?.({ term, termIndex: i + 1, totalTerms: terms.length });

        for (let p = 1; p <= maxPages; p++) {
          const url = buildSearchUrl(term, p);
          logger.info(`Scraping page ${p}`, { term, url });

          const { raws, diag } = await scrapePage(page, url);
          report.addPageDiag(diag);
          logger.debug(`Page ${p} lue`, { term, cartes: diag.cardCount, ignorees: diag.dropped });

          if (diag.cardCount === 0) {
            if (p === 1) {
              const artefacts = await captureFailure(page, "jobteaser", "zero-cards");
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

          const pageOffers = finalizeOffers(raws, "jobteaser", report);
          for (const offer of pageOffers) {
            if (!seen.has(offer.urlSource)) {
              seen.add(offer.urlSource);
              allOffers.push(offer);
            }
          }

          if (limit && allOffers.length >= limit) break searchLoop;
          if (p < maxPages) await page.waitForTimeout(1500);
        }

        await page.waitForTimeout(1500); // délai poli entre deux recherches
      }

      report.log(logger);

      const result = limit ? allOffers.slice(0, limit) : allOffers;
      logger.info(`${allOffers.length} offres collectées, ${result.length} renvoyées`);
      return result;
    } catch (error) {
      // Abort orchestrateur (timeout) ou crash : on RESTITUE les offres déjà
      // collectées plutôt que de renvoyer [] (best-effort, `allOffers` survit).
      report.log(logger);
      logger.error("Source interrompue — restitution des offres déjà collectées", {
        error: error instanceof Error ? error.message : String(error),
        collectees: allOffers.length,
      });
      return limit ? allOffers.slice(0, limit) : allOffers;
    } finally {
      await browser.close();
    }
  },
};
