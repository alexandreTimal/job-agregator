import type { RawJobOffer, Priority } from "./lib/types";
import { normalizeText } from "./lib/normalize";
import type { SearchConfig } from "../config/search.config";

export interface FilterVerdict {
  passed: boolean;
  reason?: string;
}

/**
 * Filtre 100 % déterministe. Pur : aucune I/O, aucun réseau, aucun LLM.
 * Politique « lenient » : un champ absent (salaire/lieu/contrat null) ne
 * disqualifie jamais — on ne rejette que sur une information présente qui
 * contredit la config.
 */
export function passesFilters(offer: RawJobOffer, config: SearchConfig): FilterVerdict {
  const haystack = normalizeText(`${offer.title} ${offer.company ?? ""}`);

  // 1) Mots-clés d'exclusion (titre + entreprise)
  for (const term of config.exclude ?? []) {
    const needle = normalizeText(term);
    if (needle && haystack.includes(needle)) {
      return { passed: false, reason: `exclu:${term}` };
    }
  }

  // 2) Type de contrat (lenient si null)
  if (config.contractTypes?.length && offer.contractType) {
    const oc = normalizeText(offer.contractType);
    const ok = config.contractTypes.some((c) => oc.includes(normalizeText(c)));
    if (!ok) return { passed: false, reason: `contrat:${offer.contractType}` };
  }

  // 3) Salaire minimum (lenient si non parsable / absent)
  if (config.salaryMin && offer.salary) {
    const annual = parseSalary(offer.salary);
    if (annual !== null && annual < config.salaryMin) {
      return { passed: false, reason: `salaire:${annual}` };
    }
  }

  // 4) Localisation (lenient si null) ; "remote" accepté si l'offre est distante
  if (config.locations?.length && offer.location) {
    const ol = normalizeText(offer.location);
    const wantsRemote = config.locations.some((l) => normalizeText(l) === "remote");
    const isRemote = /(remote|teletravail|full remote|100 remote)/.test(ol);
    const cityMatch = config.locations.some((l) => {
      const nl = normalizeText(l);
      return nl !== "remote" && nl !== "" && ol.includes(nl);
    });
    if (!cityMatch && !(wantsRemote && isRemote)) {
      return { passed: false, reason: `lieu:${offer.location}` };
    }
  }

  return { passed: true };
}

/**
 * Estime un salaire ANNUEL (€) à partir d'un texte libre.
 * Heuristique lenient : renvoie null si rien d'exploitable (→ l'offre passe).
 * Gère "45k", "45 000 €", fourchettes (prend le haut), mensuel → annuel.
 */
export function parseSalary(raw: string): number | null {
  // Retire tous les espaces (normaux + insécables) : "45 000 €" -> "45000€".
  const t = raw.toLowerCase().replace(/\s/g, "");
  const matches = [...t.matchAll(/(\d+(?:[.,]\d+)?)(k)?/g)];
  if (matches.length === 0) return null;

  let best = 0;
  for (const m of matches) {
    let n = parseFloat(m[1]!.replace(",", "."));
    if (Number.isNaN(n)) continue;
    if (m[2] === "k") n *= 1000;
    if (n > best) best = n;
  }
  if (best === 0) return null;

  // Mensuel -> annuel
  const monthly = /(mois|month|\/m|parmois|brutmensuel)/.test(t);
  if (monthly && best < 12000) best *= 12;

  return Math.round(best);
}

/** Score déterministe (0-100) pour trier dans Notion — pas de LLM. */
export function scoreOffer(
  offer: RawJobOffer,
  config: SearchConfig,
): { score: number; priority: Priority } {
  let score = 0;
  const title = normalizeText(offer.title);

  for (const term of config.terms) {
    if (title.includes(normalizeText(term))) score += 30;
  }
  if (offer.salary) score += 10;
  if (offer.publishedAt) {
    const ageDays = (Date.now() - offer.publishedAt.getTime()) / 86_400_000;
    if (ageDays <= 3) score += 20;
    else if (ageDays <= 7) score += 10;
  }

  score = Math.min(100, score);
  const priority: Priority = score >= 60 ? "🔴 Haute" : score >= 30 ? "🟠 Moyenne" : "🟢 Basse";
  return { score, priority };
}
