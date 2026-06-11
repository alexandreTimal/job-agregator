import { createHash } from "node:crypto";

const DIACRITICS = /[̀-ͯ]/g;

/**
 * Normalise un texte pour comparaison/hash : minuscules, sans accents,
 * ponctuation réduite à des espaces, espaces compactés.
 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Clé de dédup = hash composite normalisé (titre + entreprise + lieu).
 * Volontairement PAS basé sur l'URL : un re-post change d'URL mais reste
 * le même poste — le hash composite le capte.
 */
export function computeHash(offer: {
  title: string;
  company: string | null;
  location: string | null;
}): string {
  const key = [
    normalizeText(offer.title),
    normalizeText(offer.company),
    normalizeText(offer.location),
  ].join("|");
  return createHash("sha1").update(key).digest("hex");
}
