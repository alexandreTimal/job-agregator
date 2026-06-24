import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, buildKeyword, isJobOfferHref, isChallengePage } from "./jobteaser";

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

test("buildKeyword : injecte la ville dans le mot-clé (émulation recherche par lieu)", () => {
  assert.equal(buildKeyword("Product Manager", "Lyon"), "Product Manager Lyon");
});

test("buildKeyword : sans ville (slot null) → mot-clé inchangé", () => {
  assert.equal(buildKeyword("Product Manager", null), "Product Manager");
});

test("buildKeyword : la ville se retrouve bien dans le q de l'URL", () => {
  const url = buildSearchUrl(buildKeyword("Growth Manager", "Lyon"), 1);
  assert.equal(new URL(url).searchParams.get("q"), "Growth Manager Lyon");
});

test("isChallengePage : page Cloudflare réelle détectée (marqueurs de la capture)", () => {
  // Extraits réels de data/debug/jobteaser-zero-cards-…08-41-38….html
  const cf = `<html><head><meta http-equiv="refresh" content="360">
    <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=a10a"></script></head>
    <body><noscript><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></noscript>
    Test de sécurité — Verify you are human</body></html>`;
  assert.equal(isChallengePage(cf), true);
});

test("isChallengePage : variantes de marqueurs", () => {
  assert.equal(isChallengePage('<div class="cf-turnstile"></div>'), true);
  assert.equal(isChallengePage("Just a moment..."), true);
});

test("isChallengePage : vraie page de résultats JobTeaser → false", () => {
  const real = '<html><body><article data-testid="jobad-card">Product Manager</article></body></html>';
  assert.equal(isChallengePage(real), false);
});

test("isChallengePage : entrée vide/nullish → false", () => {
  assert.equal(isChallengePage(""), false);
  assert.equal(isChallengePage(null), false);
  assert.equal(isChallengePage(undefined), false);
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
