/**
 * Agrégation PURE des répartitions de la page Stats.
 *
 * Sépare le « comment présenter » (top N + seaux) de la requête sqlite : le
 * store ne fait que `GROUP BY` puis appelle ces helpers. Aucun I/O ici.
 */
import type { LabeledCount } from "../shared/types";

/** Libellés des seaux synthétiques (réutilisés par l'UI via le contrat). */
export const OTHERS_LABEL = "Autres";
export const UNSPECIFIED_LABEL = "Non précisé";

/**
 * Agrège des décomptes de localisation en une liste lisible :
 * - lieux vides (`null` / `""`) regroupés dans un seau « Non précisé » ;
 * - lieux nommés triés par volume décroissant ;
 * - au-delà de `topN`, la traîne est sommée dans un seau « Autres ».
 *
 * Ordre final : lieux nommés (par volume), puis « Autres » (si > 0), puis
 * « Non précisé » (si > 0). Une offre sans lieu n'est JAMAIS ignorée.
 */
export function aggregateLocations(
  rows: { location: string | null; count: number }[],
  topN = 8,
): LabeledCount[] {
  let unspecified = 0;
  const named: LabeledCount[] = [];
  for (const { location, count } of rows) {
    const label = (location ?? "").trim();
    if (label === "") unspecified += count;
    else named.push({ label, count });
  }

  named.sort((a, b) => b.count - a.count);

  const head = named.slice(0, topN);
  const tail = named.slice(topN);
  const result = [...head];

  const othersCount = tail.reduce((acc, r) => acc + r.count, 0);
  if (othersCount > 0) result.push({ label: OTHERS_LABEL, count: othersCount });
  if (unspecified > 0) result.push({ label: UNSPECIFIED_LABEL, count: unspecified });

  return result;
}
