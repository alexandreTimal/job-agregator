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
}

export interface ScrapingSource {
  name: string;
  fetch(options?: FetchOptions): Promise<RawJobOffer[]>;
}
