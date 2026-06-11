/**
 * Formatage d'ancienneté « il y a X » (français), déterministe.
 *
 * Propre à la lane Offres. Convertit une date ISO 8601 en libellé relatif au
 * moment fourni (`now`, par défaut l'instant courant). Aucun I/O, fonction pure
 * et testable.
 */

/** Bornes successives, du plus fin au plus grossier (en secondes). */
const PALIERS: { limite: number; diviseur: number; singulier: string; pluriel: string }[] = [
  { limite: 60, diviseur: 1, singulier: "seconde", pluriel: "secondes" },
  { limite: 3600, diviseur: 60, singulier: "minute", pluriel: "minutes" },
  { limite: 86400, diviseur: 3600, singulier: "heure", pluriel: "heures" },
  { limite: 2592000, diviseur: 86400, singulier: "jour", pluriel: "jours" },
  { limite: 31536000, diviseur: 2592000, singulier: "mois", pluriel: "mois" },
  { limite: Infinity, diviseur: 31536000, singulier: "an", pluriel: "ans" },
];

/**
 * Rend une chaîne « il y a X » à partir d'une date ISO.
 *
 * @param iso   Date ISO 8601 (ou null) — typiquement `publishedAt ?? firstSeenAt`.
 * @param now   Instant de référence (ms epoch), injectable pour les tests.
 */
export function ancienneteRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "date inconnue";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "date inconnue";

  const ecartSecondes = Math.max(0, Math.floor((now - ts) / 1000));
  if (ecartSecondes < 5) return "à l'instant";

  for (const palier of PALIERS) {
    if (ecartSecondes < palier.limite) {
      const valeur = Math.floor(ecartSecondes / palier.diviseur);
      const mot = valeur > 1 ? palier.pluriel : palier.singulier;
      return `il y a ${valeur} ${mot}`;
    }
  }
  return "date inconnue";
}
