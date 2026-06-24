import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedLocationTokens, METRO_AREAS } from "./metro-areas";

test("acceptedLocationTokens : inclut toujours la ville elle-même (normalisée)", () => {
  const toks = acceptedLocationTokens("Lyon");
  assert.ok(toks.includes("lyon"));
});

test("acceptedLocationTokens : ajoute les communes de la métropole (Lyon → Villeurbanne)", () => {
  const toks = acceptedLocationTokens("Lyon");
  assert.ok(toks.includes("villeurbanne"));
  assert.ok(toks.includes("venissieux")); // accents retirés
});

test("acceptedLocationTokens : lookup insensible à la casse et aux accents", () => {
  assert.deepEqual(acceptedLocationTokens("LYON"), acceptedLocationTokens("lyon"));
});

test("acceptedLocationTokens : ville sans métropole connue → juste elle-même", () => {
  assert.deepEqual(acceptedLocationTokens("Bordeaux"), ["bordeaux"]);
});

test("acceptedLocationTokens : entrée vide → []", () => {
  assert.deepEqual(acceptedLocationTokens(""), []);
  assert.deepEqual(acceptedLocationTokens("  "), []);
});

test("METRO_AREAS : communes distinctives (≥ 4 lettres une fois normalisées)", () => {
  // Garde-fou anti faux-positif : le filtre matche en sous-chaîne `includes`.
  for (const communes of Object.values(METRO_AREAS)) {
    for (const c of communes) {
      const n = c
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      assert.ok(n.length >= 4, `commune trop courte (risque faux positif): "${c}"`);
    }
  }
});
