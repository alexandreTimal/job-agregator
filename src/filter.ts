import type { RawJobOffer, Priority } from "./lib/types";
import { normalizeText } from "./lib/normalize";
import { acceptedLocationTokens } from "./lib/metro-areas";
import { classifyContractType } from "./lib/contract-type";
import type { SearchConfig } from "../config/search.config";

export interface FilterVerdict {
  passed: boolean;
  reason?: string;
}

/** Nombre de millisecondes dans une journée (calcul d'ancienneté). */
const MS_PER_DAY = 86_400_000;

/**
 * Filtre 100 % déterministe. Pur : aucune I/O, aucun réseau, aucun LLM.
 * Politique « lenient » pour salaire/lieu/date : un champ absent ne disqualifie
 * jamais. Le **type de contrat** fait exception : il est toujours tranché par
 * `classifyContractType` (binaire stage/CDI, sur le titre quand la source laisse
 * `contractType` null, ex. LinkedIn), donc une offre du mauvais contrat EST
 * rejetée même sans valeur brute — sinon « stage » ne serait pas sélectionnable.
 *
 * `now` est injecté (défaut `Date.now()`) pour garder la fonction pure et
 * testable malgré le critère d'ancienneté.
 */
export function passesFilters(
  offer: RawJobOffer,
  config: SearchConfig,
  now: number = Date.now(),
): FilterVerdict {
  const haystack = normalizeText(`${offer.title} ${offer.company ?? ""}`);

  // Familles de contrat sélectionnées (binaire stage/CDI via classifyContractType).
  // Sert au filtre (2) ET à neutraliser les exclusions « famille stage ».
  const selectedClasses = new Set(
    (config.contractTypes ?? []).map((c) => classifyContractType(c)),
  );

  // 1) Mots-clés d'exclusion (titre + entreprise)
  for (const term of config.exclude ?? []) {
    const needle = normalizeText(term);
    if (!needle) continue;
    // Un terme d'exclusion qui SIGNALE un stage (stage/stagiaire/alternance/
    // apprentissage…) ne doit pas disqualifier quand « stage » est sélectionné —
    // sinon ces libellés de search.config.ts tueraient les offres voulues.
    // On ne neutralise QUE la famille stage : classifyContractType ne renvoie
    // "stage" que sur un vrai signal (jamais par défaut), donc un terme métier
    // ("senior", "manager") reste bien exclu même quand « CDI » est sélectionné.
    if (selectedClasses.has("stage") && classifyContractType(term) === "stage") continue;
    if (haystack.includes(needle)) {
      return { passed: false, reason: `exclu:${term}` };
    }
  }

  // 1b) Blacklist de titre (mot ENTIER, TITRE seul) — pilotée par l'UI, distincte
  // de l'exclude auto-seedé : pas de neutralisation « famille stage », pas de
  // match entreprise. On enveloppe titre normalisé ET terme d'espaces pour borner
  // sur des mots entiers sans regex (gère aussi les expressions multi-mots) :
  // " lead " match " lead data engineer " mais pas " leadership analyst ".
  const paddedTitle = ` ${normalizeText(offer.title)} `;
  for (const term of config.titleBlacklist ?? []) {
    const needle = normalizeText(term);
    if (!needle) continue;
    if (paddedTitle.includes(` ${needle} `)) {
      return { passed: false, reason: `titre-banni:${term}` };
    }
  }

  // 2) Type de contrat — classification déterministe (stage vs CDI). Tranche même
  // sans valeur brute : LinkedIn/Greenhouse laissent contractType null, on classe
  // alors sur le titre. (La recherche LinkedIn est en plus contrainte en amont via
  // f_JT ; ce filtre rattrape les CDI qui fuient malgré tout.)
  if (config.contractTypes?.length) {
    const cls = classifyContractType(offer.title, offer.contractType);
    if (!selectedClasses.has(cls)) {
      return { passed: false, reason: `contrat:${cls}` };
    }
  }

  // 3) Salaire minimum (lenient si non parsable / absent)
  if (config.salaryMin && offer.salary) {
    const annual = parseSalary(offer.salary);
    if (annual !== null && annual < config.salaryMin) {
      return { passed: false, reason: `salaire:${annual}` };
    }
  }

  // 4) Localisation (lenient si null) ; "remote" accepté si l'offre est distante.
  // Une ville demandée matche aussi les communes de sa métropole (cf.
  // `acceptedLocationTokens` : « Villeurbanne » compte pour Lyon) — sinon les
  // offres de banlieue proche, pourtant ramenées par le rayon de recherche des
  // sources, étaient rejetées faute de contenir le nom de la ville-centre.
  if (config.locations?.length && offer.location) {
    const ol = normalizeText(offer.location);
    const wantsRemote = config.locations.some((l) => normalizeText(l) === "remote");
    const isRemote = /(remote|teletravail|full remote|100 remote)/.test(ol);
    const cityMatch = config.locations.some((l) => {
      const nl = normalizeText(l);
      if (nl === "remote" || nl === "") return false;
      return acceptedLocationTokens(l).some((tok) => ol.includes(tok));
    });
    if (!cityMatch && !(wantsRemote && isRemote)) {
      return { passed: false, reason: `lieu:${offer.location}` };
    }
  }

  // 5) Ancienneté de mise en ligne (lenient si date absente ; 0 = sans limite).
  // Limite inclusive : une offre pile à `maxOfferAgeDays` jours passe encore.
  if (config.maxOfferAgeDays && config.maxOfferAgeDays > 0 && offer.publishedAt) {
    const ageDays = (now - offer.publishedAt.getTime()) / MS_PER_DAY;
    if (ageDays > config.maxOfferAgeDays) {
      // `ceil` : un rejet n'est jamais étiqueté ≤ limite (ex. 7.3 j → "age:8",
      // pas "age:7" qui se lirait comme la limite inclusive qui passe encore).
      return { passed: false, reason: `age:${Math.ceil(ageDays)}` };
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

/** Score déterministe (0-100) pour trier les offres dans l'UI — pas de LLM. */
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
