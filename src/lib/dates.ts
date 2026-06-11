const DIACRITICS = /[̀-ͯ]/g;

/**
 * Détecte la présence d'une année plausible (4 chiffres dans la plage
 * 1900-2099) dans un texte. Sert de garde-fou avant d'interpréter une
 * chaîne brute comme une date absolue : on évite ainsi qu'une suite de
 * 4 chiffres quelconque (ex. un identifiant) soit prise pour une date.
 */
function hasPlausibleYear(text: string): boolean {
  return /\b(?:19|20)\d{2}\b/.test(text);
}

/**
 * Parse best-effort une date de publication brute extraite du DOM.
 * Gère :
 *  - les dates absolues (ISO ou attribut `datetime`, ex. `2026-06-10T08:00:00Z`),
 *    validées par la présence d'une année plausible (1900-2099) ;
 *  - les formes relatives françaises (« aujourd'hui », « hier »,
 *    « il y a 3 jours », « il y a 2 semaines », « il y a 1 mois »).
 * Renvoie `null` si rien d'exploitable n'est trouvé (best-effort strict).
 *
 * Fonction pure : aucun I/O, aucun effet de bord (hors lecture de l'heure
 * courante pour résoudre les dates relatives).
 */
export function parsePublishedAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  // 1) Date absolue (ISO ou attribut datetime). On exige une année plausible
  //    pour ne pas interpréter une chaîne contenant 4 chiffres arbitraires
  //    comme une date.
  if (hasPlausibleYear(text)) {
    const isoCandidate = new Date(text);
    if (!Number.isNaN(isoCandidate.getTime())) {
      return isoCandidate;
    }
  }

  const lower = text.normalize("NFD").replace(DIACRITICS, "").toLowerCase();

  // 2) Formes relatives explicites.
  const now = new Date();
  if (/\baujourd/.test(lower)) return now;
  if (/\bhier\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // « il y a N heure(s)/jour(s)/semaine(s)/mois/an(s) »
  const rel = lower.match(/il y a\s+(\d+)\s*(heure|jour|semaine|mois|an)/);
  if (rel) {
    const n = Number.parseInt(rel[1]!, 10);
    const unit = rel[2]!;
    const d = new Date(now);
    if (unit === "heure") d.setHours(d.getHours() - n);
    else if (unit === "jour") d.setDate(d.getDate() - n);
    else if (unit === "semaine") d.setDate(d.getDate() - n * 7);
    else if (unit === "mois") d.setMonth(d.getMonth() - n);
    else if (unit === "an") d.setFullYear(d.getFullYear() - n);
    return d;
  }

  return null;
}
