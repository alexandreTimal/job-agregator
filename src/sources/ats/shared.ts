/**
 * Briques partagées des adapters ATS (Greenhouse, Lever).
 *
 * Les API d'ATS renvoient TOUT le board d'une entreprise (pas de recherche
 * serveur). `matchesAnyTerm` émule donc le `keyword` que les sources web
 * obtiennent côté serveur : une offre n'est gardée que si son TITRE matche au
 * moins un terme. C'est une recherche, pas un filtre métier — `src/filter.ts`
 * reste pur et inchangé.
 */
import { normalizeText } from "../../lib/normalize";

/** Vrai si `title` contient au moins un des `terms` (insensible casse/accents). */
export function matchesAnyTerm(title: string, terms: string[]): boolean {
  const haystack = normalizeText(title);
  if (!haystack) return false;
  return terms.some((t) => {
    const needle = normalizeText(t);
    return needle.length > 0 && haystack.includes(needle);
  });
}
