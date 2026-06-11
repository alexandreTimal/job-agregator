import type { SearchFilters } from "../lib/source-interface";

/** Une « case » de recherche par lieu : une ville précise, ou `null` (sans contrainte). */
export type LocationSlot = NonNullable<SearchFilters["locations"]>[number] | null;

/**
 * Découpe une recherche par lieu. AUCUNE source jobboard (hellowork, linkedin…)
 * n'accepte plusieurs villes en une seule requête : on émet donc UNE recherche
 * par ville. Une source web boucle sur ces cases × ses termes (un seul
 * navigateur, hôte jamais frappé en parallèle).
 *
 * - `filters.locations` non vide → une case par ville.
 * - sinon → une seule case `null` = recherche sans contrainte de localisation
 *   (aucune ville configurée, ou « remote » seul, qui se gère en post-filtre).
 *
 * Fonction pure (aucune I/O) — couverte par `location-slots.test.ts`.
 */
export function locationSlots(filters?: SearchFilters): LocationSlot[] {
  const locs = filters?.locations;
  return locs && locs.length > 0 ? [...locs] : [null];
}
