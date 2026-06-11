import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAnyTerm } from "./shared";

test("matchesAnyTerm : match insensible à la casse et aux accents", () => {
  assert.equal(matchesAnyTerm("Senior Data Engineer", ["data engineer"]), true);
  assert.equal(matchesAnyTerm("Ingénieur Données", ["ingenieur donnees"]), true);
});

test("matchesAnyTerm : aucun terme ne matche", () => {
  assert.equal(matchesAnyTerm("Account Executive", ["data engineer", "ml engineer"]), false);
});

test("matchesAnyTerm : liste de termes vide → false (rien ne passe)", () => {
  assert.equal(matchesAnyTerm("Data Engineer", []), false);
});
