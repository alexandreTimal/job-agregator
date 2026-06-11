/**
 * Types partagés — SOURCE DE VÉRITÉ du contrat web/ ↔ src/server/.
 *
 * Ces types sont importés à la fois par le serveur Fastify (`src/server/`) et
 * par l'UI React (`web/`). Ils décrivent EXACTEMENT les formes échangées par
 * l'API REST documentée dans `docs/api-contract.md`.
 *
 * ⚠️ Contrat figé : ne plus modifier sans synchroniser docs/api-contract.md
 * ET prévenir les agents qui consomment ces types.
 */

/**
 * Une offre telle qu'exposée à l'UI (jamais les offres `deleted = 1`).
 *
 * - `id`            : identifiant sqlite (clé primaire de `seen_offers`).
 * - `liked`         : 1 si l'offre est en favori, sinon 0.
 * - `publishedAt`   : vraie date de publication scrapée (ISO 8601) ou null.
 * - `firstSeenAt`   : date de première découverte par le pipeline (ISO 8601).
 *                     L'UI affiche `publishedAt ?? firstSeenAt` pour l'ancienneté.
 */
export interface Offer {
  id: number;
  hash: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  source: string;
  score: number;
  liked: boolean;
  publishedAt: string | null;
  firstSeenAt: string;
}

/** Filtre de liste appliqué à GET /api/offers. */
export type OfferFilter = "all" | "liked";

/** Tri appliqué à GET /api/offers (les likées remontent toujours en tête). */
export type OfferSort = "recent" | "score";

/**
 * Configuration EFFECTIVE pilotée par l'UI (table sqlite `settings`).
 *
 * - `contractTypes` : valeurs possibles "stage" et "CDI".
 * - `enabledSources`: noms des sources actives (cf. registry des sources).
 * - `atsBoards`     : pour chaque source ATS (greenhouse, lever), la liste des
 *                     tokens d'entreprise à interroger. Ex. `{ greenhouse: ["stripe"] }`.
 */
export interface Settings {
  terms: string[];
  contractTypes: string[];
  enabledSources: string[];
  atsBoards: Record<string, string[]>;
}

/** Comptage d'offres par source, avec le chemin du logo local. */
export interface SourceCount {
  source: string;
  count: number;
  logo: string;
}

/** Une ligne de la table `runs` (un lancement de pipeline). */
export interface Run {
  id: number;
  startedAt: string;
  durationMs: number | null;
  found: number;
  new: number;
  duplicates: number;
  perSource: Record<string, number>;
}

/** Réponse de GET /api/stats. */
export interface Stats {
  today: number;
  week: number;
  duplicates: number;
  bySource: SourceCount[];
  lastRuns: Run[];
}

/**
 * Événement SSE émis sur GET /api/run/stream pendant un run.
 *
 * - `type: 'progress'` : avancement (term/source/found renseignés best-effort).
 * - `type: 'done'`     : run terminé proprement.
 * - `type: 'error'`    : run échoué (message renseigné).
 */
export interface RunEvent {
  type: "progress" | "done" | "error";
  term?: string;
  source?: string;
  found?: number;
  message?: string;
}
