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

/** Mois français → index (0-11). Clés normalisées (sans diacritiques, minuscules). */
const FRENCH_MONTHS: Record<string, number> = {
  janvier: 0,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
};

/**
 * Parse une date absolue française du type « 21 mai 2026 » (ou abrégée
 * « 21 sept. 2025 »). `new Date()` ne sait pas lire les noms de mois français :
 * c'est exactement le genre de chaîne que `parsePublishedAt` remontait en WARN.
 * Le texte reçu est déjà normalisé (sans diacritiques, en minuscules).
 */
function parseFrenchAbsoluteDate(lower: string): Date | null {
  const m = lower.match(/\b(\d{1,2})\s+([a-z]+)\.?\s+((?:19|20)\d{2})\b/);
  if (!m) return null;

  const day = Number.parseInt(m[1]!, 10);
  const word = m[2]!;
  const year = Number.parseInt(m[3]!, 10);

  // Mois exact, sinon abréviation (« sept » → septembre, « fevr » → fevrier).
  let month = FRENCH_MONTHS[word];
  if (month === undefined) {
    const key = Object.keys(FRENCH_MONTHS).find((k) => k.startsWith(word));
    if (key === undefined) return null;
    month = FRENCH_MONTHS[key]!;
  }

  if (day < 1 || day > 31) return null;
  // Midi UTC (et non minuit local) : une date de publication n'a pas d'heure ;
  // ancrer à midi UTC garantit que la composante jour reste identique quel que
  // soit le fuseau (sinon `toISOString()` décale d'un jour en CEST).
  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

/**
 * Parse best-effort une date de publication brute extraite du DOM.
 * Gère :
 *  - les dates absolues (ISO ou attribut `datetime`, ex. `2026-06-10T08:00:00Z`),
 *    validées par la présence d'une année plausible (1900-2099) ;
 *  - les formes relatives françaises (« aujourd'hui », « hier »,
 *    « il y a 12 minutes », « il y a 3 jours », « il y a 2 semaines »,
 *    « il y a 1 mois », « le mois dernier », « la semaine dernière »).
 * Renvoie `null` si rien d'exploitable n'est trouvé (best-effort strict).
 *
 * Fonction pure : aucun I/O, aucun effet de bord (hors lecture de l'heure
 * courante pour résoudre les dates relatives).
 */
export function parsePublishedAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  // 1) Date absolue ISO / attribut `datetime` (ex. « 2026-06-10T08:00:00Z »).
  //    On exige une forme RÉELLEMENT ISO (`YYYY-MM-DD`) avant de déléguer à
  //    `new Date()` : sinon le parser laxiste de V8 interprète mal des
  //    abréviations françaises anglo-compatibles (« 1 sept. 2025 » lu comme
  //    une date anglaise erronée), avant même notre parser FR ci-dessous.
  if (hasPlausibleYear(text) && /\d{4}-\d{2}-\d{2}/.test(text)) {
    const isoCandidate = new Date(text);
    if (!Number.isNaN(isoCandidate.getTime())) {
      return isoCandidate;
    }
  }

  const lower = text.normalize("NFD").replace(DIACRITICS, "").toLowerCase();

  // 2) Date absolue française (« 21 mai 2026 ») — non gérée par `new Date()`.
  const frAbsolute = parseFrenchAbsoluteDate(lower);
  if (frAbsolute) return frAbsolute;

  // 3) Formes relatives explicites.
  const now = new Date();
  if (/\baujourd/.test(lower)) return now;
  // « avant-hier » AVANT « hier » : le motif `\bhier\b` matche aussi le « hier »
  // de « avant-hier » (le trait d'union forme une frontière de mot), ce qui le
  // résoudrait à tort à J-1. On capte donc J-2 en premier.
  if (/avant[-\s]?hier/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 2);
    return d;
  }
  if (/\bhier\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // « il y a N seconde(s)/minute(s)/heure(s)/jour(s)/semaine(s)/mois/an(s) ».
  // Les sous-jour (seconde/minute/heure) sont rares mais réels (JobTeaser rend
  // « il y a 12 minutes ») : on les résout au même jour calendaire.
  const rel = lower.match(/il y a\s+(\d+)\s*(seconde|minute|heure|jour|semaine|mois|an)/);
  if (rel) {
    return subtractRelativeUnit(now, rel[2]!, Number.parseInt(rel[1]!, 10));
  }

  // Formes « le/la … dernier(ère) » ou « passé(e) » = il y a 1 unité
  // (« le mois dernier », « la semaine dernière », « l'an dernier »).
  const last = lower.match(/(seconde|minute|heure|jour|semaine|mois|annee|an)\s+(?:derni|passe)/);
  if (last) {
    const unit = last[1] === "annee" ? "an" : last[1]!;
    return subtractRelativeUnit(now, unit, 1);
  }

  return null;
}

/** Soustrait `n` unités relatives françaises à une date (copie, pure). */
function subtractRelativeUnit(now: Date, unit: string, n: number): Date {
  const d = new Date(now);
  if (unit === "seconde") d.setSeconds(d.getSeconds() - n);
  else if (unit === "minute") d.setMinutes(d.getMinutes() - n);
  else if (unit === "heure") d.setHours(d.getHours() - n);
  else if (unit === "jour") d.setDate(d.getDate() - n);
  else if (unit === "semaine") d.setDate(d.getDate() - n * 7);
  else if (unit === "mois") d.setMonth(d.getMonth() - n);
  else if (unit === "an") d.setFullYear(d.getFullYear() - n);
  return d;
}

/**
 * Ajoute `days` jours OUVRABLES (lundi–vendredi) à une date, en sautant les
 * week-ends (samedi/dimanche). Aucun jour férié n'est pris en compte (hors
 * scope assumé).
 *
 * Le résultat est ancré à midi UTC (comme `parseFrenchAbsoluteDate`) pour que
 * la composante jour reste stable quel que soit le fuseau d'affichage : on
 * raisonne sur une date calendaire (la date de relance), pas sur un instant.
 *
 * Fonction pure et déterministe : aucun I/O. Sert au calcul de la date de
 * relance après une candidature (« +3 jours ouvrables »).
 *
 * @param from  Instant de départ ; seul le JOUR calendaire UTC est lu (heure ignorée).
 * @param days  Nombre de jours ouvrables à ajouter (entier ≥ 0 ; tronqué et borné à 0).
 */
export function addBusinessDays(from: Date, days: number): Date {
  // Ancre à midi UTC sur le jour calendaire UTC de `from`.
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12, 0, 0),
  );
  let remaining = Math.max(0, Math.trunc(days));
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay(); // 0 = dimanche … 6 = samedi
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return d;
}
