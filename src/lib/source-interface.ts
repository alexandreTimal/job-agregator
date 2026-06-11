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
}

export interface ScrapingSource {
  name: string;
  /** "web" (scraping navigateur, défaut) ou "ats" (API JSON par board). */
  kind?: "web" | "ats";
  fetch(options?: FetchOptions): Promise<RawJobOffer[]>;
}
