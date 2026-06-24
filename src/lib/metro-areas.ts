import { normalizeText } from "./normalize";

/**
 * Communes rattachées à une métropole, pour que le filtre de localisation
 * accepte une offre de la banlieue proche quand la ville-centre est demandée
 * (ex. « Villeurbanne » quand on cherche Lyon). Les sources web ramènent déjà
 * ces communes via leur rayon de recherche (`ray`/`defaultRadiusKm`) ; sans
 * cette table, `filter.ts` les REJETAIT (la chaîne de lieu ne contient pas
 * « lyon »), gaspillant des offres pourtant collectées — pénalisant surtout
 * Lyon, dont la métropole pèse proportionnellement plus que Paris.
 *
 * Données de RÉFÉRENCE (pas un critère piloté par l'UI). Clés = villes-centres,
 * valeurs = communes acceptées en plus. Tout est comparé en texte NORMALISÉ
 * (cf. `normalizeText`) ; on écrit donc ici la forme lisible, normalisée à
 * l'exécution pour éviter toute dérive d'orthographe/accents.
 *
 * Communes volontairement DISTINCTIVES (≥ 4 lettres, peu ambiguës) : le match
 * est un `includes` de sous-chaîne (cohérent avec le filtre), donc un token
 * trop court ou trop commun risquerait un faux positif.
 */
export const METRO_AREAS: Record<string, string[]> = {
  Lyon: [
    "Villeurbanne",
    "Vénissieux",
    "Caluire-et-Cuire",
    "Vaulx-en-Velin",
    "Saint-Priest",
    "Écully",
    "Oullins",
    "Saint-Fons",
    "Décines-Charpieu",
    "Meyzieu",
    "Rillieux-la-Pape",
    "Tassin-la-Demi-Lune",
    "Craponne",
    "Francheville",
  ],
  Paris: [
    "Boulogne-Billancourt",
    "La Défense",
    "Puteaux",
    "Courbevoie",
    "Neuilly-sur-Seine",
    "Issy-les-Moulineaux",
    "Levallois-Perret",
    "Montrouge",
    "Saint-Denis",
    "Saint-Ouen",
    "Montreuil",
    "Nanterre",
    "Suresnes",
    "Gennevilliers",
  ],
};

/**
 * Tokens de lieu (normalisés) acceptés pour une ville demandée : la ville
 * elle-même + les communes de sa métropole (`METRO_AREAS`). Une offre passe le
 * filtre de lieu si sa localisation contient l'un de ces tokens. Renvoie au
 * minimum `[normalize(city)]` (ville sans métropole connue). Fonction pure.
 */
export function acceptedLocationTokens(city: string): string[] {
  const base = normalizeText(city);
  if (!base) return [];
  const tokens = new Set<string>([base]);
  for (const [centre, communes] of Object.entries(METRO_AREAS)) {
    if (normalizeText(centre) !== base) continue;
    for (const commune of communes) {
      const n = normalizeText(commune);
      if (n) tokens.add(n);
    }
  }
  return [...tokens];
}
