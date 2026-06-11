const ORIGIN = "https://www.linkedin.com";
// Endpoint guest : rend un fragment HTML de cartes d'offres, paginé par `start`.
// Non authentifié, mais rate-limité (429/999 si frappé trop vite).
const GUEST_SEARCH_PATH = "/jobs-guest/jobs/api/seeMoreJobPostings/search";

/**
 * Construit l'URL de l'endpoint guest pour un terme, une ville et un offset.
 * `location` vide ⇒ paramètre omis (recherche mondiale). Fonction pure.
 */
export function buildGuestSearchUrl(term: string, location: string, start: number): string {
  const params = new URLSearchParams();
  params.set("keywords", term);
  if (location) params.set("location", location);
  params.set("start", String(start));
  return `${ORIGIN}${GUEST_SEARCH_PATH}?${params.toString()}`;
}

/**
 * Nettoie une URL d'offre : retire les paramètres de tracking (refId, trackingId…)
 * pour obtenir l'URL canonique `…/jobs/view/<id>`. Préfixe les href relatifs par
 * l'origine LinkedIn. Best-effort : un href invalide est renvoyé tel quel.
 * Fonction pure.
 */
export function cleanJobUrl(href: string): string {
  if (!href) return href;
  try {
    const u = new URL(href, ORIGIN);
    return `${u.origin}${u.pathname}`;
  } catch {
    return href;
  }
}
