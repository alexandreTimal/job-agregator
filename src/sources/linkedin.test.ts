import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuestSearchUrl, cleanJobUrl } from "./linkedin";

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
