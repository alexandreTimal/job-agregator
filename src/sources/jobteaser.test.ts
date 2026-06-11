import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, isJobOfferHref } from "./jobteaser";

test("buildSearchUrl : encode le terme dans q, page 1 sans param page", () => {
  const url = buildSearchUrl("data engineer", 1);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://www.jobteaser.com/fr/job-offers");
  assert.equal(u.searchParams.get("q"), "data engineer");
  assert.equal(u.searchParams.has("page"), false);
});

test("buildSearchUrl : page > 1 → param page présent", () => {
  const url = buildSearchUrl("développeur", 3);
  const u = new URL(url);
  assert.equal(u.searchParams.get("q"), "développeur");
  assert.equal(u.searchParams.get("page"), "3");
});

test("isJobOfferHref : vraie offre (relative ou absolue) → true", () => {
  assert.equal(isJobOfferHref("/fr/job-offers/3f2a1b9c-acme-data-engineer"), true);
  assert.equal(
    isJobOfferHref("https://www.jobteaser.com/fr/job-offers/3f2a1b9c-acme-data-engineer"),
    true,
  );
  assert.equal(isJobOfferHref("/en/job-offers/abcdef12-corp-intern"), true);
});

test("isJobOfferHref : carte sponsorisée / non-offre → false", () => {
  // « Campagne de recrutement » pointe vers le fil d'actu d'une entreprise.
  assert.equal(isJobOfferHref("/fr/companies/acme/newsfeed/123"), false);
  // URL de recherche nue (pas de segment offre).
  assert.equal(isJobOfferHref("/fr/job-offers"), false);
  assert.equal(isJobOfferHref("/fr/job-offers?q=data"), false);
  assert.equal(isJobOfferHref(null), false);
  assert.equal(isJobOfferHref(undefined), false);
  assert.equal(isJobOfferHref(""), false);
});
