import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions } from "../lib/source-interface";
import { locationSlots } from "./location-slots";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult, PageDiag } from "../lib/parse-report";
import { captureFailure } from "../lib/debug-capture";
import { normalizeText } from "../lib/normalize";

const logger = createLogger("LINKEDIN");

const ORIGIN = "https://www.linkedin.com";
// Endpoint guest : rend un fragment HTML de cartes d'offres, paginé par `start`.
// Non authentifié, mais rate-limité (429/999 si frappé trop vite).
const GUEST_SEARCH_PATH = "/jobs-guest/jobs/api/seeMoreJobPostings/search";

// Conteneur d'une offre dans le fragment guest.
const CARD_SELECTOR = "div.base-card";

/**
 * Codes `f_JT` (job type) de la recherche LinkedIn guest, par type de contrat.
 *
 * La carte guest LinkedIn n'expose PAS le type de contrat (contractType reste
 * null) : le filtre déterministe aval ne peut donc pas trancher stage vs CDI
 * (politique lenient → tout passe). On contraint la recherche EN AMONT via le
 * paramètre serveur `f_JT`, exactement comme une source ATS émule la recherche
 * serveur. Ce n'est PAS du filtrage métier (filter.ts reste pur) — c'est
 * l'équivalent du `keyword`, mais pour le type de contrat.
 *
 *   - stage → "I" (Internship)
 *   - CDI   → "F" (Full-time)
 *
 * Un type inconnu est ignoré ; aucune contrainte → comportement historique
 * (tous types confondus). Codes LinkedIn complets : F=Full-time, P=Part-time,
 * C=Contract, T=Temporary, I=Internship, V=Volunteer, O=Other.
 */
const JOB_TYPE_CODES: Record<string, string> = {
  stage: "I",
  cdi: "F",
};

/**
 * Mappe nos types de contrat (cf. UI : "stage"/"CDI") vers les codes `f_JT`
 * LinkedIn, dédupliqués, en ignorant les types inconnus. Fonction pure.
 */
export function contractTypesToJobTypes(contractTypes?: string[]): string[] {
  const codes = new Set<string>();
  for (const c of contractTypes ?? []) {
    const code = JOB_TYPE_CODES[normalizeText(c)];
    if (code) codes.add(code);
  }
  return [...codes];
}

/**
 * Construit l'URL de l'endpoint guest pour un terme, une ville et un offset.
 * `location` vide ⇒ paramètre omis (recherche mondiale). `jobTypes` (codes
 * `f_JT`) vide ⇒ paramètre omis (tous types de contrat). Fonction pure.
 */
export function buildGuestSearchUrl(
  term: string,
  location: string,
  start: number,
  jobTypes: string[] = [],
): string {
  const params = new URLSearchParams();
  params.set("keywords", term);
  if (location) params.set("location", location);
  // Contrainte serveur sur le type de contrat (I=stage, F=CDI…). Plusieurs
  // valeurs = liste séparée par des virgules. Absent ⇒ tous types.
  if (jobTypes.length) params.set("f_JT", jobTypes.join(","));
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

/**
 * Seuil (longueur d'innerText trimmé) en-dessous duquel le body est jugé « vide ».
 * La réponse 0-résultat de l'endpoint guest est un body quasi vide
 * (`<body></body>`, innerText ≈ 0), tandis qu'une vraie page de cartes en a des
 * milliers — 32 est donc une frontière sûre, loin des deux régimes.
 */
const EMPTY_BODY_MAX = 32;

/**
 * Sur 0 carte, classe la cause en 3 verdicts à partir du statut HTTP ET du volume
 * de texte du body. Le seul statut HTTP ne suffit pas : un sélecteur cassé
 * (LinkedIn renomme `div.base-card`) sert toujours HTTP 200 + 0 carte et serait
 * sinon confondu avec une recherche vide → panne SILENCIEUSE. Le discriminateur
 * fiable est le volume de texte rendu :
 *
 * - `"blocked"` : statut null (pas de réponse) OU hors 2xx (429/403/999…) →
 *   rate-limit / réponse non-2xx. À capturer.
 * - `"empty"` : 2xx + body quasi vide (< EMPTY_BODY_MAX) → recherche sans résultat
 *   ou fin de pagination. C'est le cas normal de l'endpoint guest, PAS une panne.
 * - `"selector"` : 2xx + body plein mais 0 carte → la page a du contenu mais aucun
 *   nœud ne matche `CARD_SELECTOR` : sélecteur probablement cassé. À capturer.
 *
 * Limite connue : un challenge anti-bot servi en HTTP 200 avec un body riche
 * (interstitiel « Verify you're human ») retombe dans `"selector"` — le WARN
 * pointera alors à tort un sélecteur sain. La capture étant déclenchée dans les
 * deux cas (verdict ≠ `empty`), l'artefact HTML/PNG permet de lever le doute.
 *
 * Fonction pure.
 */
export function classifyZeroCards(input: {
  status: number | null;
  bodyTextLength: number;
}): "blocked" | "empty" | "selector" {
  const { status, bodyTextLength } = input;
  if (status === null || status < 200 || status >= 300) return "blocked";
  if (bodyTextLength < EMPTY_BODY_MAX) return "empty";
  return "selector";
}

/**
 * Résultat brut d'une page + diagnostic (cartes vues / ignorées) + statut HTTP +
 * volume de texte du body (discriminateur de `classifyZeroCards`).
 */
interface ScrapePageResult {
  raws: RawScrapeResult[];
  diag: PageDiag;
  status: number | null;
  bodyTextLength: number;
}

async function scrapePage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>,
  url: string,
): Promise<ScrapePageResult> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const status = response?.status() ?? null;

  // L'endpoint rend un fragment statique : les cartes sont présentes au
  // domcontentloaded. On tente une courte attente du sélecteur, sans bloquer.
  // On ne consomme pas le résultat de `waitForSelector` : on s'appuie
  // volontairement sur le check `diag.cardCount === 0` en aval (WARN +
  // captureFailure) pour diagnostiquer un sélecteur cassé / un rate-limit.
  await page
    .waitForSelector(CARD_SELECTOR, { timeout: 8_000 })
    .catch(() => {});

  // Le parsing se fait DANS le contexte navigateur, au plus près du DOM, puis
  // remonte sous forme de diagnostic structuré.
  //
  // NB : tout est inliné (aucune fonction nommée imbriquée). tsx/esbuild enrobe
  // sinon les fonctions nommées d'un appel `__name(...)` absent du contexte
  // navigateur, ce qui fait planter `page.evaluate` (`__name is not defined`) —
  // c'est pourquoi le nettoyage d'URL est ré-inliné ici plutôt que d'appeler
  // `cleanJobUrl`.
  const { raws, cardCount, dropped, bodyTextLength } = await page.evaluate(
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

      return {
        raws: results,
        cardCount: cards.length,
        dropped,
        bodyTextLength: (document.body?.innerText ?? "").trim().length,
      };
    },
    { origin: ORIGIN, cardSelector: CARD_SELECTOR },
  );

  return { raws, diag: { cardCount, dropped }, status, bodyTextLength };
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

    const browser = await launchBrowser();
    // Abort de l'orchestrateur (timeout/échec) : on ferme le navigateur sans
    // attendre la résolution de la promesse de fetch (les opérations Playwright
    // en cours lèveront → catch → []). Le `finally` ci-dessous reste : le double
    // close Playwright est sans danger.
    options?.signal?.addEventListener("abort", () => {
      browser.close().catch(() => {});
    });
    // L'endpoint guest LinkedIn n'expose pas le type de contrat → contractType est
    // toujours null. On le marque « non suivi » pour neutraliser le faux WARN
    // « sélecteur cassé » (aucun sélecteur à réparer). Comme filter.ts ne peut
    // donc PAS trancher stage vs CDI sur la carte, on contraint la recherche en
    // amont via `f_JT` (cf. contractTypesToJobTypes) : LinkedIn ne renvoie alors
    // que les offres du bon type de contrat.
    const jobTypes = contractTypesToJobTypes(options?.filters?.contractTypes);
    const report = new ParseReport("linkedin", new Set(["contractType"]));

    // Hoistés hors du `try` pour SURVIVRE au `catch` : à l'abort (timeout
    // orchestrateur) ou au crash, on restitue les offres déjà collectées au lieu
    // de tout jeter (cf. catch).
    const allOffers: RawJobOffer[] = [];
    const seen = new Set<string>();

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // LinkedIn n'accepte qu'UNE ville par requête → une recherche par ville
      // (cf. locationSlots), chacune bouclée sur tous les termes. Un seul
      // navigateur ; la dédup par URL (`seen`) absorbe les offres communes à
      // plusieurs villes.
      const slots = locationSlots(options?.filters);
      const totalSteps = slots.length * terms.length;
      let step = 0;

      searchLoop: for (const slot of slots) {
        const location = slot?.label ?? "";
        const lieu = location || "—";
        for (const term of terms) {
          step++;
          options?.onProgress?.({ term, termIndex: step, totalTerms: totalSteps });
          let start = 0;

          for (let p = 1; p <= maxPages; p++) {
            const url = buildGuestSearchUrl(term, location, start, jobTypes);
            logger.info(`Scraping page ${p}`, { term, lieu, jobTypes: jobTypes.join(",") || "tous", url });

            const { raws, diag, status, bodyTextLength } = await scrapePage(page, url);
            report.addPageDiag(diag);
            logger.debug(`Page ${p} lue`, { term, lieu, cartes: diag.cardCount, ignorees: diag.dropped });

            if (diag.cardCount === 0) {
              const verdict = classifyZeroCards({ status, bodyTextLength });
              if (verdict === "empty") {
                // Body vide en succès HTTP : recherche sans résultat (ou fin de pagination). Normal.
                logger.info("Aucun résultat pour ce terme (réponse vide en succès HTTP)", {
                  term,
                  lieu,
                  url,
                  status,
                });
              } else {
                // blocked (non-2xx / pas de réponse) OU selector (page pleine, 0 carte = sélecteur cassé).
                // Capture seulement en page 1 pour ne pas spammer data/debug à chaque page.
                const shouldCapture = p === 1;
                const artefacts = shouldCapture ? await captureFailure(page, "linkedin", "zero-cards") : null;
                logger.warn(
                  verdict === "blocked"
                    ? "0 carte — blocage probable (rate-limit ou réponse non-2xx)"
                    : "0 carte malgré une page non vide — sélecteur probablement cassé",
                  {
                    verdict,
                    selector: CARD_SELECTOR,
                    term,
                    lieu,
                    url,
                    status,
                    capture: artefacts
                      ? `${artefacts}.html / .png`
                      : shouldCapture
                        ? "échec capture"
                        : "non capturé (page>1)",
                  },
                );
              }
              break; // boucle de pages seulement → (lieu, terme) suivant
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

            if (limit && allOffers.length >= limit) break searchLoop;
            if (p < maxPages) await page.waitForTimeout(1500);
          }

          await page.waitForTimeout(1500); // délai poli entre deux recherches
        }
      }

      report.log(logger);
      const result = limit ? allOffers.slice(0, limit) : allOffers;
      logger.info(`${allOffers.length} offres uniques collectées, ${result.length} renvoyées`);
      return result;
    } catch (error) {
      // Abort orchestrateur (timeout) ou crash en cours de boucle : on RESTITUE
      // les offres déjà collectées plutôt que de renvoyer [] (qui transformait un
      // run tronqué en « aucune offre »). Best-effort : `allOffers` survit grâce au
      // hoisting ci-dessus.
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
