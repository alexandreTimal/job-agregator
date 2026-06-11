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
 * Clé de dédup = hash composite normalisé (titre + entreprise).
 * Volontairement PAS basé sur l'URL : un re-post change d'URL mais reste le
 * même poste — le hash composite le capte. Le LIEU est lui aussi EXCLU : les
 * sources le rendent de façon instable (« Paris » → « Paris 9e » → « Paris,
 * Île-de-France »…), si bien qu'un re-post variait de hash et échappait à la
 * dédup — et surtout à la SUPPRESSION (une offre soft-deleted réapparaissait).
 * Conséquence assumée : un même intitulé chez une même entreprise dans deux
 * villes ne compte que pour une offre.
 */
export function computeHash(offer: { title: string; company: string | null }): string {
  const key = [normalizeText(offer.title), normalizeText(offer.company)].join("|");
  return createHash("sha1").update(key).digest("hex");
}
