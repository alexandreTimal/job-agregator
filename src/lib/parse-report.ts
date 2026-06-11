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
  /**
   * Offres dont l'employeur est STRUCTURELLEMENT absent de la source (ex. annonces
   * externes agrégées de HelloWork : aucune entreprise sur la carte). Ces `company`
   * null sont *attendus* : on les exclut du WARN « sélecteur company cassé » pour
   * ne pas crier au loup. Défaut 0 ⇒ comportement inchangé pour les autres sources.
   */
  companyUnavailable?: number;
}

/** Champs dont on suit le taux de remplissage (salary exclu : non scrapé partout). */
const TRACKED_FIELDS = ["company", "location", "contractType", "publishedAt"] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

const MAX_DATE_SAMPLES = 10;
/** Seuil mini d'offres « company » remplies avant de soupçonner une valeur constante. */
const CONSTANT_MIN_SAMPLES = 3;

export class ParseReport {
  private pages = 0;
  private cards = 0;
  private kept = 0;
  private companyUnavailable = 0;
  private readonly dropped: Record<string, number> = {};
  private readonly nulls: Record<TrackedField, number> = {
    company: 0,
    location: 0,
    contractType: 0,
    publishedAt: 0,
  };
  // Valeurs distinctes de `company` (plafonné à 2 : dès qu'on en a 2, ce n'est
  // plus une constante, inutile d'en garder plus). Sert à détecter le cas
  // « champ rempli à 100% mais avec une étiquette constante » (placeholder), que
  // le WARN 100%-null ne voit pas. Limité à `company` : `location`/`contractType`
  // PEUVENT être légitimement constants (filtre géo/contrat), `company` non.
  private readonly companyValues = new Set<string>();
  private readonly unparsedDates: string[] = [];

  /**
   * @param untracked Champs sciemment non collectés par la source (ex. LinkedIn
   *   guest n'expose pas `contractType`). Leur taux de remplissage reste compté
   *   et affiché dans le bilan INFO, mais on NE lève PAS le WARN « sélecteur
   *   cassé » à leur sujet : c'est un faux positif (rien à réparer). Défaut vide
   *   ⇒ comportement strictement inchangé pour les sources existantes.
   */
  constructor(
    private readonly source: string,
    private readonly untracked: ReadonlySet<TrackedField> = new Set(),
  ) {}

  /** Enregistre le diagnostic d'une page scrapée. */
  addPageDiag(diag: PageDiag): void {
    this.pages++;
    this.cards += diag.cardCount;
    this.companyUnavailable += diag.companyUnavailable ?? 0;
    for (const [reason, n] of Object.entries(diag.dropped)) {
      this.dropped[reason] = (this.dropped[reason] ?? 0) + n;
    }
  }

  /** Comptabilise une offre conservée et la nullité de ses champs suivis. */
  observe(raw: RawScrapeResult, publishedAt: Date | null): void {
    this.kept++;
    if (!raw.company) this.nulls.company++;
    else if (this.companyValues.size < 2) this.companyValues.add(raw.company.trim().toLowerCase());
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
      ...(this.companyUnavailable > 0 ? { employeurAbsent: this.companyUnavailable } : {}),
    });

    // Alerte ciblée : champ vide à 100 % alors qu'on a bien lu des offres ⇒
    // sélecteur quasi certainement cassé. C'est LE signal à corriger en priorité.
    for (const field of TRACKED_FIELDS) {
      // Champ non collecté par cette source : null à 100% est attendu, pas un bug.
      if (this.untracked.has(field)) continue;

      // Pour `company`, on exclut les offres où l'employeur est structurellement
      // absent (ex. annonces externes HelloWork) : on ne juge « sélecteur cassé »
      // que sur les offres qui POUVAIENT exposer une entreprise.
      const expectedNull = field === "company" ? this.companyUnavailable : 0;
      const eligible = this.kept - expectedNull;
      const nulls = this.nulls[field] - expectedNull;
      if (eligible > 0 && nulls === eligible) {
        logger.warn(
          `Champ '${field}' vide sur 100% des offres — sélecteur probablement cassé`,
          { source: this.source, offres: eligible },
        );
      }
    }

    // Alerte « placeholder » : `company` rempli mais avec UNE seule valeur sur de
    // nombreuses offres ⇒ le sélecteur grappille très probablement une étiquette
    // fixe (cf. HelloWork « collectivite »). Invisible au WARN 100%-null car le
    // champ EST rempli. Limité à `company` (seul champ jamais légitimement constant).
    const companyFilled = this.kept - this.nulls.company;
    if (companyFilled >= CONSTANT_MIN_SAMPLES && this.companyValues.size === 1) {
      logger.warn(
        "Champ 'company' = valeur constante sur toutes les offres — placeholder probable (sélecteur sur une étiquette fixe ?)",
        { source: this.source, offres: companyFilled, valeur: [...this.companyValues][0] },
      );
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
