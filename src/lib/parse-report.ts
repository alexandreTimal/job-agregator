/**
 * Rapport de parsing — l'outil de diagnostic central des sources.
 *
 * Problème résolu : quand un jobboard change son markup, un sélecteur casse en
 * silence. Le scrape continue, renvoie des offres avec des champs `null`, et
 * rien ne le signale — on ne s'en aperçoit que des jours plus tard dans l'UI.
 *
 * Ce rapport AGRÈGE, sur l'ensemble d'un run de source, le taux de remplissage
 * de chaque champ et lève une alerte explicite quand un champ est vide à 100 %
 * alors que des cartes ont bien été lues — signature typique d'un sélecteur mort.
 * Il collecte aussi les dates brutes que `parsePublishedAt` n'a pas su lire, pour
 * qu'on sache exactement quels motifs ajouter dans `src/lib/dates.ts`.
 *
 * Déterministe et pur (hors le `log()` final) : aucun I/O, aucun réseau.
 */
import type { RawJobOffer } from "./types";
import { parsePublishedAt } from "./dates";
import type { Logger } from "./logger";

/** Forme brute commune renvoyée par `page.evaluate` dans chaque source. */
export interface RawScrapeResult {
  title: string;
  company: string | null;
  location: string | null;
  salary: string | null;
  contractType: string | null;
  urlSource: string;
  publishedRaw: string | null;
}

/** Diagnostic d'UNE page : combien de cartes vues, combien ignorées et pourquoi. */
export interface PageDiag {
  /** Nb d'éléments matchés par le sélecteur de carte (0 ⇒ sélecteur cassé / page vide). */
  cardCount: number;
  /** Cartes ignorées, par raison (`noTitle`, `noHref`…). */
  dropped: Record<string, number>;
}

/** Champs dont on suit le taux de remplissage (salary exclu : non scrapé partout). */
const TRACKED_FIELDS = ["company", "location", "contractType", "publishedAt"] as const;
type TrackedField = (typeof TRACKED_FIELDS)[number];

const MAX_DATE_SAMPLES = 10;

export class ParseReport {
  private pages = 0;
  private cards = 0;
  private kept = 0;
  private readonly dropped: Record<string, number> = {};
  private readonly nulls: Record<TrackedField, number> = {
    company: 0,
    location: 0,
    contractType: 0,
    publishedAt: 0,
  };
  private readonly unparsedDates: string[] = [];

  constructor(private readonly source: string) {}

  /** Enregistre le diagnostic d'une page scrapée. */
  addPageDiag(diag: PageDiag): void {
    this.pages++;
    this.cards += diag.cardCount;
    for (const [reason, n] of Object.entries(diag.dropped)) {
      this.dropped[reason] = (this.dropped[reason] ?? 0) + n;
    }
  }

  /** Comptabilise une offre conservée et la nullité de ses champs suivis. */
  observe(raw: RawScrapeResult, publishedAt: Date | null): void {
    this.kept++;
    if (!raw.company) this.nulls.company++;
    if (!raw.location) this.nulls.location++;
    if (!raw.contractType) this.nulls.contractType++;
    if (!publishedAt) {
      this.nulls.publishedAt++;
      // On ne retient que les chaînes NON vides : une date absente du DOM n'est
      // pas un échec de parsing, mais une date présente non reconnue, oui.
      if (raw.publishedRaw && this.unparsedDates.length < MAX_DATE_SAMPLES) {
        this.unparsedDates.push(raw.publishedRaw);
      }
    }
  }

  /** Émet le bilan : résumé INFO + alertes WARN sur les anomalies actionnables. */
  log(logger: Logger): void {
    const fill: Record<string, string> = {};
    for (const field of TRACKED_FIELDS) {
      const ok = this.kept - this.nulls[field];
      fill[field] = this.kept > 0 ? `${ok}/${this.kept}` : "0/0";
    }

    logger.info("Bilan parsing", {
      source: this.source,
      pages: this.pages,
      cartes: this.cards,
      conservees: this.kept,
      ignorees: this.dropped,
      remplissage: fill,
    });

    // Alerte ciblée : champ vide à 100 % alors qu'on a bien lu des offres ⇒
    // sélecteur quasi certainement cassé. C'est LE signal à corriger en priorité.
    for (const field of TRACKED_FIELDS) {
      if (this.kept > 0 && this.nulls[field] === this.kept) {
        logger.warn(
          `Champ '${field}' vide sur 100% des offres — sélecteur probablement cassé`,
          { source: this.source, offres: this.kept },
        );
      }
    }

    if (this.unparsedDates.length > 0) {
      logger.warn("Dates non reconnues par parsePublishedAt — étendre src/lib/dates.ts", {
        source: this.source,
        exemples: this.unparsedDates,
      });
    }
  }
}

/**
 * Mappe les résultats bruts d'une page en `RawJobOffer[]`, résout les dates et
 * alimente le rapport au passage. Centralise la logique commune aux sources pour
 * que l'instrumentation reste cohérente d'un jobboard à l'autre.
 */
export function finalizeOffers(
  raws: RawScrapeResult[],
  sourceName: string,
  report: ParseReport,
): RawJobOffer[] {
  return raws.map((raw) => {
    const publishedAt = parsePublishedAt(raw.publishedRaw);
    report.observe(raw, publishedAt);
    const { publishedRaw: _ignored, ...rest } = raw;
    return { ...rest, sourceName, publishedAt };
  });
}
