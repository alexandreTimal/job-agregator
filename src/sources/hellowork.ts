import type { RawJobOffer } from "../lib/types";
import type { ScrapingSource, FetchOptions, SearchFilters } from "../lib/source-interface";
import { locationSlots } from "./location-slots";
import { launchBrowser } from "../lib/browser";
import { createLogger } from "../lib/logger";
import { ParseReport, finalizeOffers } from "../lib/parse-report";
import type { RawScrapeResult, PageDiag } from "../lib/parse-report";
import { captureFailure } from "../lib/debug-capture";

const logger = createLogger("HELLOWORK");
const BASE_URL = "https://www.hellowork.com";
const SEARCH_PATH = "/fr-fr/emploi/recherche.html";
const CARD_SELECTOR = '[data-cy="serpCard"]';
// Compteur de résultats du SERP (« Afficher 0 offre » / « Afficher 1 234 offres »).
// TOUJOURS rendu (SSR Turbo), y compris à 0 résultat, et bien avant les cartes :
// on l'utilise comme signal « SERP prêt » pour ne PAS attendre 15 s à vide, et
// comme source de vérité pour distinguer « 0 résultat » (normal) d'un sélecteur cassé.
const RESULT_COUNT_SELECTOR = '[data-cy="offerNumberButton"]';

/**
 * Extrait le nombre de résultats du libellé du compteur HelloWork. Pure & testable.
 * Gère le séparateur de milliers français (espace/insécable) : « Afficher 1 234
 * offres » → 1234, « Afficher 0 offre » → 0. Renvoie null si illisible/absent.
 */
export function parseHelloworkResultCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const compact = raw.replace(/\s/g, ""); // \s couvre l'espace insécable U+00A0 en JS
  const m = compact.match(/(\d+)offres?/i);
  return m ? Number(m[1]) : null;
}

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
  /**
   * Nombre de résultats annoncé par le SERP (compteur `offerNumberButton`), ou
   * null si le compteur est illisible. Permet de distinguer une page vide
   * légitime (0) d'un sélecteur de cartes cassé (>0 mais 0 carte lue).
   */
  resultCount: number | null;
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

  // SERP prêt = SOIT une carte (résultats), SOIT le compteur (toujours rendu, même
  // à 0 résultat). On course les deux : sur une page VIDE, le compteur arrive vite
  // et on n'attend plus 15 s en pure perte (cause du timeout 600 s sur les pages
  // mortes / termes sans résultat). Le diagnostic « page vide vs sélecteur cassé »
  // est tranché en aval à partir de `resultCount`.
  // `state: "attached"` (et non le défaut "visible") : le compteur est rendu dans
  // le DOM dès le SSR mais peut être NON VISIBLE sur une page vide (conteneur
  // masqué). On veut juste sa PRÉSENCE pour savoir que le SERP a répondu ; attendre
  // la visibilité ferait expirer les 15 s — précisément la lenteur qu'on supprime.
  await page
    .waitForSelector(`${CARD_SELECTOR}, ${RESULT_COUNT_SELECTOR}`, { state: "attached", timeout: 15_000 })
    .catch(() => {
      // Ni carte ni compteur : page anormale (interstitiel, blocage…). Le check
      // `cardCount === 0` en aval lèvera le WARN + capture.
      logger.warn("Ni carte ni compteur après attente", { url });
    });

  const { raws, cardCount, dropped, companyUnavailable, countRaw } = await page.evaluate(
    ({ baseUrl, cardSelector, countSelector }) => {
      const results: RawScrapeResult[] = [];
      const dropped = { noTitle: 0, noHref: 0 };
      let companyUnavailable = 0;

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

        // Annonces EXTERNES agrégées : HelloWork n'expose AUCUN employeur sur la
        // carte (le 2e <p> du titre est un placeholder constant « collectivité »).
        // On les repère via le payload analytics (product_variant) et on met
        // company=null plutôt que de stocker une fausse entreprise. Les natives,
        // elles, gardent leur vrai employeur.
        let isExternal = false;
        const apRaw = el.getAttribute("data-analytics-values-param");
        if (apRaw) {
          try {
            const pd = JSON.parse(apRaw).product_data;
            const item = Array.isArray(pd) ? pd[0] : null;
            if (item && /EXTERNE/i.test(item.product_variant ?? "")) isExternal = true;
          } catch {
            /* analytics absent/illisible : on garde le comportement nominal */
          }
        }

        const companyEl = el.querySelector('[data-cy="offerTitle"] h3 p:nth-child(2)');
        const company = isExternal ? null : (companyEl?.textContent?.trim() ?? null);
        if (isExternal) companyUnavailable++;

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

      // Texte brut du compteur de résultats (parsé côté Node par
      // parseHelloworkResultCount, fonction pure testable).
      const countRaw = document.querySelector(countSelector)?.textContent?.trim() ?? null;

      return { raws: results, cardCount: cards.length, dropped, companyUnavailable, countRaw };
    },
    { baseUrl: BASE_URL, cardSelector: CARD_SELECTOR, countSelector: RESULT_COUNT_SELECTOR },
  );

  const resultCount = parseHelloworkResultCount(countRaw);

  return { raws, diag: { cardCount, dropped, companyUnavailable }, resultCount };
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

    // Hoistés hors du `try` pour SURVIVRE au `catch` : à l'abort (timeout
    // orchestrateur) ou au crash, on restitue les offres déjà collectées au lieu
    // de tout jeter (cf. catch).
    const allOffers: RawJobOffer[] = [];
    const seen = new Set<string>();

    try {
      const page = await browser.newPage();

      // HelloWork n'accepte qu'UNE ville par requête → une recherche par ville
      // (cf. locationSlots), chacune bouclée sur tous les termes. Un seul
      // navigateur : un même hôte n'est jamais frappé en parallèle. La dédup par
      // URL (`seen`) absorbe les offres communes à plusieurs villes.
      const slots = locationSlots(options?.filters);
      const totalSteps = slots.length * terms.length;
      let step = 0;

      searchLoop: for (const slot of slots) {
        const lieu = slot?.label ?? "—";
        for (const term of terms) {
          step++;
          options?.onProgress?.({ term, termIndex: step, totalTerms: totalSteps });
          const filters: SearchFilters = {
            ...options?.filters,
            keyword: term,
            locations: slot ? [slot] : undefined,
          };

          for (let p = 1; p <= maxPages; p++) {
            const url = buildSearchUrl(p, filters);
            logger.info(`Scraping page ${p}`, { term, lieu, url });

            const { raws, diag, resultCount } = await scrapePage(page, url);
            report.addPageDiag(diag);
            logger.debug(`Page ${p} lue`, {
              term, lieu, cartes: diag.cardCount, ignorees: diag.dropped, resultCount,
            });

            if (diag.cardCount === 0) {
              // 0 carte. Le compteur `offerNumberButton` est le TOTAL de la
              // recherche (pas le nb de cette page) : il reste non nul sur une page
              // au-delà de la dernière. Seul cas réellement suspect = PAGE 1 avec
              // des résultats annoncés (compteur ≠ 0, ou illisible) mais 0 carte
              // lue ⇒ sélecteur racine cassé / page anormale : WARN + capture.
              if (p === 1 && resultCount !== 0) {
                const artefacts = await captureFailure(page, "hellowork", "zero-cards");
                logger.warn("0 carte en page 1 malgré des résultats — sélecteur racine probablement cassé", {
                  selector: CARD_SELECTOR,
                  resultCount,
                  term,
                  lieu,
                  url,
                  capture: artefacts ? `${artefacts}.html / .png` : "échec capture",
                });
              } else {
                // resultCount === 0 (recherche sans résultat) OU page > 1 (fin de
                // pagination normale). Aucune anomalie : simple INFO.
                logger.info(`Aucune offre, arrêt pagination`, { term, lieu, page: p, resultCount });
              }
              break; // boucle de pages seulement → (lieu, terme) suivant
            }

            const pageOffers = finalizeOffers(raws, "hellowork", report);
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
      }

      report.log(logger);

      const result = limit ? allOffers.slice(0, limit) : allOffers;
      logger.info(`${allOffers.length} offres collectées, ${result.length} renvoyées`);
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
