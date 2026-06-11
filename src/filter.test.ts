import { test } from "node:test";
import assert from "node:assert/strict";
import { passesFilters } from "./filter";
import type { RawJobOffer } from "./lib/types";
import type { SearchConfig } from "../config/search.config";

/** `now` fixe pour rendre les calculs d'ancienneté déterministes. */
const NOW = Date.UTC(2026, 5, 11, 12, 0, 0); // 2026-06-11T12:00:00Z

/** Offre minimale valide ; `daysAgo` pilote `publishedAt` (null si omis). */
function offer(daysAgo: number | null): RawJobOffer {
  return {
    title: "data engineer",
    company: "Acme",
    location: null,
    salary: null,
    contractType: null,
    urlSource: "https://example.com/1",
    sourceName: "test",
    publishedAt: daysAgo === null ? null : new Date(NOW - daysAgo * 86_400_000),
  };
}

/** Config ne contraignant QUE l'ancienneté (les autres critères neutres). */
function ageConfig(maxOfferAgeDays: number | undefined): SearchConfig {
  return { terms: ["data engineer"], exclude: [], maxOfferAgeDays };
}

test("filtre d'âge : offre récente (sous la limite) passe", () => {
  const v = passesFilters(offer(2), ageConfig(7), NOW);
  assert.equal(v.passed, true);
});

test("filtre d'âge : offre trop ancienne est rejetée avec reason age:<n>", () => {
  const v = passesFilters(offer(10), ageConfig(7), NOW);
  assert.equal(v.passed, false);
  assert.equal(v.reason, "age:10");
});

test("filtre d'âge : reason arrondi au jour SUPÉRIEUR (rejet jamais étiqueté ≤ limite)", () => {
  // 7,3 jours avec limite 7 : rejeté ; reason "age:8" (et non "age:7" qui se
  // lirait comme la limite inclusive qui passe encore).
  const v = passesFilters(offer(7.3), ageConfig(7), NOW);
  assert.equal(v.passed, false);
  assert.equal(v.reason, "age:8");
});

test("filtre d'âge : limite inclusive (pile à maxOfferAgeDays jours passe)", () => {
  const v = passesFilters(offer(7), ageConfig(7), NOW);
  assert.equal(v.passed, true);
});

test("filtre d'âge : maxOfferAgeDays=0 désactive le filtre", () => {
  const v = passesFilters(offer(30), ageConfig(0), NOW);
  assert.equal(v.passed, true);
});

test("filtre d'âge : maxOfferAgeDays absent => aucune contrainte d'âge", () => {
  const v = passesFilters(offer(365), ageConfig(undefined), NOW);
  assert.equal(v.passed, true);
});

test("filtre d'âge : date de publication absente => offre conservée (lenient)", () => {
  const v = passesFilters(offer(null), ageConfig(7), NOW);
  assert.equal(v.passed, true);
});

// --- Filtre par type de contrat (classification déterministe stage/CDI) ---

/** Offre au titre/contrat custom (le reste neutre, sans contrainte d'âge). */
function contractOffer(title: string, raw: string | null = null): RawJobOffer {
  return {
    title,
    company: "Acme",
    location: null,
    salary: null,
    contractType: raw,
    urlSource: "https://example.com/1",
    sourceName: "test",
    publishedAt: null,
  };
}

/** Config contrat : `contractTypes` + `exclude` réaliste (cf. search.config). */
function contractConfig(contractTypes: string[], exclude: string[] = []): SearchConfig {
  return { terms: ["data engineer"], exclude, contractTypes };
}

test("contrat : stage demandé, contractType null (LinkedIn) — titre stage passe", () => {
  const v = passesFilters(contractOffer("Stage Product Manager"), contractConfig(["stage"]), NOW);
  assert.equal(v.passed, true);
});

test("contrat : stage demandé, contractType null — un CDI (titre non-stage) est REJETÉ", () => {
  // C'est le bug d'origine : LinkedIn rend contractType null, le CDI passait.
  const v = passesFilters(contractOffer("Senior Product Manager"), contractConfig(["stage"]), NOW);
  assert.equal(v.passed, false);
  assert.equal(v.reason, "contrat:CDI");
});

test("contrat : stage demandé — alternance/apprentissage classés stage passent", () => {
  for (const t of ["Alternance - Product Manager (F/H)", "Apprenti Data Engineer"]) {
    assert.equal(passesFilters(contractOffer(t), contractConfig(["stage"]), NOW).passed, true, t);
  }
});

test("contrat : CDI demandé — un stage (titre) est rejeté", () => {
  const v = passesFilters(contractOffer("Stagiaire Data Engineer"), contractConfig(["CDI"]), NOW);
  assert.equal(v.passed, false);
  assert.equal(v.reason, "contrat:stage");
});

test("contrat : contractType brut fait foi quand présent (WTTJ/Hellowork)", () => {
  // Titre neutre mais contrat brut "CDI" → classé CDI → rejeté si on veut un stage.
  const v = passesFilters(contractOffer("Data Engineer", "CDI"), contractConfig(["stage"]), NOW);
  assert.equal(v.passed, false);
});

test("exclude : 'stagiaire'/'alternance' ne tuent PAS un stage quand stage est demandé", () => {
  const cfg = contractConfig(["stage"], ["stage", "stagiaire", "alternance", "apprentissage"]);
  assert.equal(passesFilters(contractOffer("Stagiaire Growth"), cfg, NOW).passed, true);
  assert.equal(passesFilters(contractOffer("Alternance Growth"), cfg, NOW).passed, true);
});

test("exclude : un terme MÉTIER reste exclu même quand CDI est sélectionné", () => {
  // Régression évitée : "senior" se classe CDI par défaut, mais ne doit pas être
  // neutralisé — seule la famille stage l'est, et uniquement si stage est choisi.
  const cfg = contractConfig(["CDI"], ["senior"]);
  const v = passesFilters(contractOffer("Senior Data Engineer"), cfg, NOW);
  assert.equal(v.passed, false);
  assert.equal(v.reason, "exclu:senior");
});

test("contrat : sans contractTypes configuré → aucune contrainte de contrat", () => {
  const cfg: SearchConfig = { terms: ["x"], exclude: [] };
  assert.equal(passesFilters(contractOffer("Stage Whatever"), cfg, NOW).passed, true);
  assert.equal(passesFilters(contractOffer("Senior Whatever"), cfg, NOW).passed, true);
});
