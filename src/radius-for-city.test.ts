import { test } from "node:test";
import assert from "node:assert/strict";
import { radiusForCity } from "./index";

test("radiusForCity : surcharge par ville prioritaire sur le défaut", () => {
  assert.equal(radiusForCity("Lyon", { Lyon: 50 }, 30), 50);
});

test("radiusForCity : lookup insensible casse/accents", () => {
  assert.equal(radiusForCity("lyon", { Lyon: 50 }, 30), 50);
  assert.equal(radiusForCity("LYON", { Lyon: 50 }, 30), 50);
});

test("radiusForCity : ville sans surcharge → défaut", () => {
  assert.equal(radiusForCity("Paris", { Lyon: 50 }, 30), 30);
});

test("radiusForCity : pas de surcharge ni défaut → null", () => {
  assert.equal(radiusForCity("Paris", undefined, undefined), null);
  assert.equal(radiusForCity("Paris", {}, undefined), null);
});
