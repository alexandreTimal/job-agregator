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

// --- Filtre par localisation (villes + métropole + remote) ---

/** Offre au lieu custom (le reste neutre). */
function locationOffer(location: string | null): RawJobOffer {
  return {
    title: "data engineer",
    company: "Acme",
    location,
    salary: null,
    contractType: null,
    urlSource: "https://example.com/1",
    sourceName: "test",
    publishedAt: null,
  };
}

/** Config ne contraignant QUE le lieu. */
function locConfig(locations: string[]): SearchConfig {
  return { terms: ["data engineer"], exclude: [], locations };
}

test("lieu : ville demandée matchée en sous-chaîne, accents/casse ignorés", () => {
  assert.equal(passesFilters(locationOffer("Lyon 3e"), locConfig(["Lyon"]), NOW).passed, true);
  assert.equal(passesFilters(locationOffer("LYON"), locConfig(["lyon"]), NOW).passed, true);
});

test("lieu : commune de la métropole acceptée (Villeurbanne compte pour Lyon)", () => {
  // Le cœur du levier « métropole » : sans table, Villeurbanne était rejeté.
  assert.equal(passesFilters(locationOffer("Villeurbanne"), locConfig(["Lyon"]), NOW).passed, true);
  assert.equal(passesFilters(locationOffer("Vénissieux"), locConfig(["Lyon"]), NOW).passed, true);
  assert.equal(passesFilters(locationOffer("La Défense"), locConfig(["Paris"]), NOW).passed, true);
});

test("lieu : ville hors périmètre rejetée avec reason lieu:<valeur>", () => {
  const v = passesFilters(locationOffer("Marseille"), locConfig(["Lyon"]), NOW);
  assert.equal(v.passed, false);
  assert.equal(v.reason, "lieu:Marseille");
});

test("lieu : lenient si location absente", () => {
  assert.equal(passesFilters(locationOffer(null), locConfig(["Lyon"]), NOW).passed, true);
});

test("lieu : 'remote' demandé → offre distante passe même hors villes", () => {
  const cfg = locConfig(["Lyon", "remote"]);
  assert.equal(passesFilters(locationOffer("Full remote"), cfg, NOW).passed, true);
  assert.equal(passesFilters(locationOffer("Télétravail"), cfg, NOW).passed, true);
});

// --- Blacklist de titre (mot entier, titre seul, insensible casse/accents) ---

/** Offre au titre/entreprise custom, sans aucune autre contrainte de filtre. */
function titleOffer(title: string, company: string | null = "Acme"): RawJobOffer {
  return {
    title,
    company,
    location: null,
    salary: null,
    contractType: null,
    urlSource: "https://example.com/1",
    sourceName: "test",
    publishedAt: null,
  };
}

/** Config ne contraignant QUE la blacklist de titre. */
function banConfig(titleBlacklist: string[]): SearchConfig {
  return { terms: ["data engineer"], exclude: [], titleBlacklist };
}

test("blacklist titre : mot entier présent → rejeté avec reason titre-banni:<mot>", () => {
  const v = passesFilters(titleOffer("Lead Data Engineer"), banConfig(["lead"]), NOW);
  assert.equal(v.passed, false);
  assert.equal(v.reason, "titre-banni:lead");
});

test("blacklist titre : sous-chaîne d'un autre mot ne bannit PAS", () => {
  // « lead » ne doit pas tuer « Leadership » (cœur du choix mot-entier).
  assert.equal(passesFilters(titleOffer("Leadership Analyst"), banConfig(["lead"]), NOW).passed, true);
});

test("blacklist titre : match sur le TITRE seul, jamais l'entreprise", () => {
  // Le mot est dans l'entreprise, pas le titre → l'offre passe.
  const v = passesFilters(titleOffer("Data Engineer", "Acme Sales"), banConfig(["sales"]), NOW);
  assert.equal(v.passed, true);
});

test("blacklist titre : insensible à la casse et aux accents", () => {
  assert.equal(passesFilters(titleOffer("Modele 3D Designer"), banConfig(["modèle"]), NOW).passed, false);
  assert.equal(passesFilters(titleOffer("SALES Engineer"), banConfig(["sales"]), NOW).passed, false);
});

test("blacklist titre : expression multi-mots matche la séquence exacte", () => {
  assert.equal(passesFilters(titleOffer("Data Center Technician"), banConfig(["data center"]), NOW).passed, false);
  // Les mots existent séparément mais pas la séquence → passe.
  assert.equal(passesFilters(titleOffer("Data Engineer (Center team)"), banConfig(["data center"]), NOW).passed, true);
});

test("blacklist titre : liste vide ou absente → aucun bannissement", () => {
  assert.equal(passesFilters(titleOffer("Lead Data Engineer"), banConfig([]), NOW).passed, true);
  const noField: SearchConfig = { terms: ["data engineer"], exclude: [] };
  assert.equal(passesFilters(titleOffer("Lead Data Engineer"), noField, NOW).passed, true);
});
