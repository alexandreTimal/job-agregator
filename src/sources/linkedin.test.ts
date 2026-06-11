import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGuestSearchUrl,
  cleanJobUrl,
  classifyZeroCards,
  contractTypesToJobTypes,
} from "./linkedin";

test("buildGuestSearchUrl : encode keyword + location + start", () => {
  const url = buildGuestSearchUrl("data engineer", "Paris", 0);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
  assert.equal(u.searchParams.get("keywords"), "data engineer");
  assert.equal(u.searchParams.get("location"), "Paris");
  assert.equal(u.searchParams.get("start"), "0");
});

test("buildGuestSearchUrl : start incrémenté présent dans l'URL", () => {
  const url = buildGuestSearchUrl("ml engineer", "Paris", 25);
  assert.equal(new URL(url).searchParams.get("start"), "25");
});

test("buildGuestSearchUrl : location vide → paramètre location omis", () => {
  const url = buildGuestSearchUrl("data engineer", "", 0);
  assert.equal(new URL(url).searchParams.has("location"), false);
});

test("buildGuestSearchUrl : jobTypes vide → f_JT omis (tous types)", () => {
  const url = buildGuestSearchUrl("data engineer", "Paris", 0, []);
  assert.equal(new URL(url).searchParams.has("f_JT"), false);
});

test("buildGuestSearchUrl : jobTypes → f_JT en liste séparée par virgules", () => {
  const url = buildGuestSearchUrl("data engineer", "Paris", 0, ["I", "F"]);
  assert.equal(new URL(url).searchParams.get("f_JT"), "I,F");
});

test("contractTypesToJobTypes : stage → I (Internship)", () => {
  assert.deepEqual(contractTypesToJobTypes(["stage"]), ["I"]);
});

test("contractTypesToJobTypes : CDI → F (insensible à la casse/accents)", () => {
  assert.deepEqual(contractTypesToJobTypes(["CDI"]), ["F"]);
});

test("contractTypesToJobTypes : stage + CDI → I et F (sans doublon)", () => {
  assert.deepEqual(contractTypesToJobTypes(["stage", "CDI", "stage"]), ["I", "F"]);
});

test("contractTypesToJobTypes : type inconnu ignoré ; vide/undefined → []", () => {
  assert.deepEqual(contractTypesToJobTypes(["freelance"]), []);
  assert.deepEqual(contractTypesToJobTypes([]), []);
  assert.deepEqual(contractTypesToJobTypes(undefined), []);
});

test("cleanJobUrl : strip des paramètres de tracking", () => {
  const dirty =
    "https://www.linkedin.com/jobs/view/data-engineer-at-acme-123456789?refId=abc&trackingId=xyz&position=1";
  assert.equal(cleanJobUrl(dirty), "https://www.linkedin.com/jobs/view/data-engineer-at-acme-123456789");
});

test("cleanJobUrl : URL déjà propre est inchangée", () => {
  const clean = "https://www.linkedin.com/jobs/view/data-engineer-at-acme-123456789";
  assert.equal(cleanJobUrl(clean), clean);
});

test("cleanJobUrl : href relatif est préfixé par l'origine LinkedIn", () => {
  assert.equal(
    cleanJobUrl("/jobs/view/123456789?refId=abc"),
    "https://www.linkedin.com/jobs/view/123456789",
  );
});

test("cleanJobUrl : href invalide → chaîne d'origine (best-effort)", () => {
  assert.equal(cleanJobUrl(""), "");
});

test("classifyZeroCards : statut non-2xx → blocked", () => {
  assert.equal(classifyZeroCards({ status: 429, bodyTextLength: 0 }), "blocked");
  assert.equal(classifyZeroCards({ status: 403, bodyTextLength: 5000 }), "blocked");
  assert.equal(classifyZeroCards({ status: 999, bodyTextLength: 0 }), "blocked");
  assert.equal(classifyZeroCards({ status: null, bodyTextLength: 0 }), "blocked");
});
test("classifyZeroCards : 2xx + body vide → empty (recherche sans résultat)", () => {
  assert.equal(classifyZeroCards({ status: 200, bodyTextLength: 0 }), "empty");
  assert.equal(classifyZeroCards({ status: 200, bodyTextLength: 10 }), "empty");
  assert.equal(classifyZeroCards({ status: 204, bodyTextLength: 0 }), "empty");
});
test("classifyZeroCards : 2xx + body plein mais 0 carte → selector (sélecteur cassé)", () => {
  assert.equal(classifyZeroCards({ status: 200, bodyTextLength: 5000 }), "selector");
  assert.equal(classifyZeroCards({ status: 200, bodyTextLength: 33 }), "selector");
});
