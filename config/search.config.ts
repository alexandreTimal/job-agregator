/**
 * Configuration de recherche — le seul endroit à éditer pour piloter l'agrégateur.
 *
 * - `terms`       : termes envoyés en `keyword` à chaque source (= ce que tu cherches).
 * - `exclude`     : mots-clés qui disqualifient une offre (matchés sur titre + entreprise).
 * - `salaryMin`   : salaire annuel minimum (€) — lenient : une offre sans salaire passe.
 * - `locations`   : villes acceptées + "remote" (lenient : offre sans lieu passe).
 * - `contractTypes`: types de contrat acceptés (lenient : offre sans contrat passe).
 * - `remote`      : préférence remote transmise aux sources qui la supportent.
 *
 * Édition = `git diff`. Aucune infra, aucun LLM : filtrage 100 % déterministe.
 */
export interface SearchConfig {
  terms: string[];
  exclude: string[];
  salaryMin?: number;
  locations?: string[];
  contractTypes?: string[];
  remote?: "onsite" | "hybrid" | "remote" | "any";
  defaultRadiusKm?: number;
  maxPagesPerSource?: number;
}

export const config: SearchConfig = {
  terms: ["data engineer", "machine learning engineer"],
  exclude: ["stage", "stagiaire", "alternance", "apprentissage"],
  salaryMin: 45000,
  locations: ["Paris", "remote"],
  contractTypes: ["CDI"],
  remote: "any",
  defaultRadiusKm: 30,
  maxPagesPerSource: 3,
};
