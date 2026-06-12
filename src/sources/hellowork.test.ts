import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHelloworkResultCount } from "./hellowork";

test("parseHelloworkResultCount : 0 résultat (page vide)", () => {
  assert.equal(parseHelloworkResultCount("Afficher 0 offre"), 0);
  assert.equal(parseHelloworkResultCount("0 offre"), 0);
});

test("parseHelloworkResultCount : singulier / pluriel", () => {
  assert.equal(parseHelloworkResultCount("Afficher 1 offre"), 1);
  assert.equal(parseHelloworkResultCount("Afficher 42 offres"), 42);
});

test("parseHelloworkResultCount : séparateur de milliers (espace insécable U+00A0)", () => {
  assert.equal(parseHelloworkResultCount("Afficher 1 234 offres"), 1234);
  assert.equal(parseHelloworkResultCount("Afficher 12 345 offres"), 12345);
  assert.equal(parseHelloworkResultCount("Afficher 1 234 567 offres"), 1234567);
});

test("parseHelloworkResultCount : illisible / absent → null", () => {
  assert.equal(parseHelloworkResultCount(null), null);
  assert.equal(parseHelloworkResultCount(undefined), null);
  assert.equal(parseHelloworkResultCount(""), null);
  assert.equal(parseHelloworkResultCount("Afficher les résultats"), null);
});
