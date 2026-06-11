import type { RawJobOffer } from "./types";

export interface SearchFilters {
  keyword?: string;
  locations?: { label: string; radius: number | null }[];
  contractTypes?: string[];
  remotePreference?: "onsite" | "hybrid" | "remote" | "any";
}

export interface FetchOptions {
  limit?: number;
  maxPages?: number;
  filters?: SearchFilters;
  /**
   * Tous les termes de recherche du run. Les sources web bouclent dessus en
   * interne (un seul navigateur, hôte jamais frappé en parallèle) ; les sources
   * ATS s'en servent pour l'inclusion par titre (`matchesAnyTerm`).
   */
  terms?: string[];
  /** Boards à interroger (sources ATS uniquement) : tokens d'entreprise. */
  boards?: string[];
  /** Signal d'annulation : à l'abort, la source libère ses ressources (ferme son navigateur). */
  signal?: AbortSignal;
  /**
   * Rappel de progression intra-source (best-effort, purement informatif).
   * Les sources web l'appellent au début de chaque terme pour que l'UI bouge
   * pendant qu'un seul navigateur boucle tous les termes. `termIndex` est 1-based.
   */
  onProgress?: (info: { term?: string; termIndex?: number; totalTerms?: number }) => void;
}

export interface ScrapingSource {
  name: string;
  /** "web" (scraping navigateur, défaut) ou "ats" (API JSON par board). */
  kind?: "web" | "ats";
  fetch(options?: FetchOptions): Promise<RawJobOffer[]>;
}
