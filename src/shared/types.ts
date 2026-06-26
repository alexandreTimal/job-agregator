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
 * - `appliedAt`     : date du clic « J'ai postulé » (ISO 8601) ou null (non postulée).
 *                     Sert de drapeau « postulée » ET de point de départ de la relance.
 * - `followUpAt`    : date de relance DÉRIVÉE = `appliedAt` + 3 jours ouvrables
 *                     (week-ends sautés), ou null si non postulée. Jamais stockée.
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
  appliedAt: string | null;
  followUpAt: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
}

/** Filtre de liste appliqué à GET /api/offers. */
export type OfferFilter = "all" | "liked" | "applied";

/** Tri appliqué à GET /api/offers (les likées remontent toujours en tête). */
export type OfferSort = "recent" | "score";

/**
 * Configuration EFFECTIVE pilotée par l'UI (table sqlite `settings`).
 *
 * - `contractTypes` : valeurs possibles "stage" et "CDI".
 * - `enabledSources`: noms des sources actives (cf. registry des sources).
 * - `atsBoards`     : pour chaque source ATS (greenhouse, lever), la liste des
 *                     tokens d'entreprise à interroger. Ex. `{ greenhouse: ["stripe"] }`.
 * - `salaryMin`     : salaire annuel minimum en € (entier ≥ 0 ; 0 = sans minimum).
 *                     Une offre sans salaire (ou non parsable) passe (lenient).
 * - `locations`     : villes acceptées (sans "remote", géré par `remoteOk`). Pilote
 *                     AUSSI la recherche : chaque ville = une recherche distincte sur
 *                     les sources qui filtrent par lieu (hellowork, linkedin). Liste
 *                     vide = aucune contrainte de ville. Une offre sans lieu passe (lenient).
 * - `remoteOk`      : accepte les offres en télétravail (en plus des `locations`).
 * - `maxOfferAgeDays`: ancienneté max de mise en ligne en jours (entier ≥ 0 ;
 *                     0 = sans limite). Une offre sans `publishedAt` passe (lenient).
 * - `titleBlacklist`: mots qui bannissent une offre quand ils apparaissent comme
 *                     MOT ENTIER dans le TITRE (jamais l'entreprise), insensible
 *                     casse/accents. Distinct de l'`exclude` statique (titre +
 *                     entreprise, sous-chaîne). Liste vide = aucun bannissement.
 * - `cronEnabled`   : active la planification automatique des runs (scheduler serveur).
 * - `cronTimes`     : horaires quotidiens "HH:MM" (heure locale) des runs planifiés.
 */
export interface Settings {
  terms: string[];
  contractTypes: string[];
  enabledSources: string[];
  atsBoards: Record<string, string[]>;
  salaryMin: number;
  locations: string[];
  remoteOk: boolean;
  maxOfferAgeDays: number;
  titleBlacklist: string[];
  cronEnabled: boolean;
  cronTimes: string[];
}

/**
 * Les 9 critères de recherche/filtrage qu'un PROFIL capture (tout `Settings`
 * SAUF `cronEnabled`/`cronTimes`, qui restent globaux car la planification est
 * système, pas un angle de recherche). Voir `SearchProfile`.
 */
export type ProfileCriteria = Omit<Settings, "cronEnabled" | "cronTimes">;

/**
 * Un profil de recherche nommé : un angle d'écoute complet (mots-clés ET
 * filtres). Un seul profil est actif à la fois ; chaque run utilise les critères
 * du profil actif. `getSettings()` fusionne ces critères avec le cron global et
 * rend toujours la forme `Settings` plate — le pipeline reste donc intact.
 *
 * - `id`   : identifiant stable (jamais ré-affecté ; sert de clé d'activation).
 * - `name` : libellé éditable affiché dans le sélecteur de l'UI.
 */
export interface SearchProfile extends ProfileCriteria {
  id: string;
  name: string;
}

/** Vue allégée d'un profil pour le sélecteur (sans les critères). */
export interface SearchProfileMeta {
  id: string;
  name: string;
}

/** Réponse de GET /api/profiles : la liste des profils + lequel est actif. */
export interface ProfilesState {
  activeProfileId: string;
  profiles: SearchProfileMeta[];
}

/** Comptage d'offres par source, avec le chemin du logo local. */
export interface SourceCount {
  source: string;
  count: number;
  logo: string;
}

/**
 * Décompte étiqueté générique (répartitions par localisation / type de contrat).
 *
 * `label` peut être une valeur réelle (« Paris », « CDI ») ou un seau synthétique
 * (« Autres », « Non précisé » pour les lieux). Le pourcentage est calculé côté
 * UI sur le total, comme pour `SourceCount`.
 */
export interface LabeledCount {
  label: string;
  count: number;
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
  /** Répartition des offres par localisation (top N + « Autres » + « Non précisé »). */
  byLocation: LabeledCount[];
  /** Répartition des offres par type de contrat (« Stage » / « CDI »). */
  byContract: LabeledCount[];
  lastRuns: Run[];
}

/**
 * Événement SSE émis sur GET /api/run/stream pendant un run.
 *
 * - `type: 'progress'` : avancement (champs ci-dessous renseignés best-effort).
 * - `type: 'done'`     : run terminé proprement (`newOffers`/`found` renseignés).
 * - `type: 'error'`    : run échoué (message renseigné).
 *
 * Sur un `progress`, `phase` distingue les sous-étapes (tous champs optionnels,
 * compat ascendante du contrat SSE) :
 * - `start`          : lancement du run (`totalSources`, `totalTerms`).
 * - `source-start`   : une source démarre son fetch (`source`).
 * - `source-progress`: une source web avance sur ses termes
 *                      (`source`, `term`, `termIndex`, `totalTerms`).
 * - `source-done`    : une source a fini (`source`, `found`, `sourcesDone`,
 *                      `totalSources`).
 */
export interface RunEvent {
  type: "progress" | "done" | "error";
  phase?: "start" | "source-start" | "source-progress" | "source-done";
  term?: string;
  source?: string;
  found?: number;
  /** Nombre d'offres NOUVELLES retenues, renseigné sur l'événement `done`. */
  newOffers?: number;
  /** Compteur global : sources terminées / total (phases `start`/`source-done`). */
  sourcesDone?: number;
  totalSources?: number;
  /** Avancement intra-source : index du terme en cours (1-based) / total. */
  termIndex?: number;
  totalTerms?: number;
  message?: string;
}

/**
 * Statut de la génération de candidature d'une offre (CV adapté + lettre),
 * produite localement par un agent `claude` (abonnement, sans clé API).
 *
 * - `none`       : rien n'a été demandé pour cette offre.
 * - `queued`     : demandée, en attente d'un créneau (plafond de concurrence atteint).
 * - `generating` : l'agent tourne (cv-tailoring + boucle de fit + cv-render + lettre).
 * - `ready`      : CV et lettre disponibles sur disque.
 * - `failed`     : la génération a échoué (voir `error`).
 *
 * Chaque offre a sa propre candidature, INDÉPENDANTE des autres : plusieurs
 * peuvent être `generating` en parallèle (pas de verrou global, contrairement au run).
 */
export type CandidatureStatus = "none" | "queued" | "generating" | "ready" | "failed";

/**
 * État de la candidature d'une offre (GET /api/offers/:id/candidature).
 *
 * - `offerId`     : identifiant de l'offre concernée.
 * - `status`      : étape courante (cf. CandidatureStatus).
 * - `cvReady`     : le PDF du CV existe (servi par .../candidature/cv).
 * - `lettreReady` : la lettre existe (servie par .../candidature/lettre).
 * - `generatedAt` : date ISO de la dernière génération réussie, ou null.
 * - `error`       : message d'échec si `status = "failed"`, sinon null.
 */
export interface CandidatureState {
  offerId: number;
  status: CandidatureStatus;
  cvReady: boolean;
  lettreReady: boolean;
  generatedAt: string | null;
  error: string | null;
}

/**
 * Événement SSE de GET /api/candidatures/stream : un changement d'état de
 * candidature (une offre à la fois). `phase` est un libellé d'avancement humain
 * best-effort, renseigné pendant `generating` (optionnel, compat ascendante).
 */
export interface CandidatureEvent extends CandidatureState {
  phase?: string;
}
