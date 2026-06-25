/**
 * Configuration de recherche — le seul endroit à éditer pour piloter l'agrégateur.
 *
 * - `terms`       : termes envoyés en `keyword` à chaque source (= ce que tu cherches).
 * - `exclude`     : mots-clés qui disqualifient une offre (matchés sur titre + entreprise).
 * - `titleBlacklist`: mots qui bannissent une offre quand ils apparaissent comme MOT
 *                    ENTIER dans le TITRE seul (insensible casse/accents). Piloté par
 *                    l'UI. Distinct d'`exclude` (sous-chaîne, titre + entreprise).
 * - `salaryMin`   : salaire annuel minimum (€) — lenient : une offre sans salaire passe.
 * - `locations`   : villes acceptées + "remote" (lenient : offre sans lieu passe).
 * - `contractTypes`: types de contrat acceptés (lenient : offre sans contrat passe).
 * - `maxOfferAgeDays`: ancienneté max de mise en ligne, en jours (0 = sans limite,
 *                    lenient : offre sans date de publication passe).
 * - `remote`      : préférence remote transmise aux sources qui la supportent.
 * - `defaultRadiusKm`: rayon de recherche par défaut (km) appliqué à chaque ville.
 * - `radiusByCity` : rayon spécifique par ville (km) — surcharge `defaultRadiusKm`.
 *                    Ex. élargir Lyon pour capter sa métropole (Villeurbanne…).
 *                    Lookup insensible à la casse/aux accents.
 *
 * Édition = `git diff`. Aucune infra, aucun LLM : filtrage 100 % déterministe.
 */
export interface SearchConfig {
  terms: string[];
  exclude: string[];
  titleBlacklist?: string[];
  salaryMin?: number;
  locations?: string[];
  contractTypes?: string[];
  maxOfferAgeDays?: number;
  remote?: "onsite" | "hybrid" | "remote" | "any";
  defaultRadiusKm?: number;
  radiusByCity?: Record<string, number>;
  maxPagesPerSource?: number;
}

export const config: SearchConfig = {
  terms: ["data engineer", "machine learning engineer"],
  exclude: ["stage", "stagiaire", "alternance", "apprentissage"],
  // Bannissement par mot entier sur le titre seul — piloté depuis l'UI Paramètres.
  // Vide par défaut : aucun mot banni tant que l'utilisateur n'en ajoute pas.
  titleBlacklist: [],
  salaryMin: 45000,
  locations: ["Paris", "remote"],
  contractTypes: ["CDI"],
  maxOfferAgeDays: 7,
  remote: "any",
  defaultRadiusKm: 30,
  // Lyon élargi : sa métropole (Villeurbanne, Vénissieux…) tient dans ~50 km,
  // là où ces postes (souvent parisiens) sont rares — on ratisse plus large.
  radiusByCity: { Lyon: 50 },
  maxPagesPerSource: 3,
};
