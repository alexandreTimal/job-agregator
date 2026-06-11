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
