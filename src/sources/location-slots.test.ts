import { test } from "node:test";
import assert from "node:assert/strict";
import { locationSlots } from "./location-slots";

test("locationSlots : sans lieu → une seule case nulle (recherche sans contrainte)", () => {
  assert.deepEqual(locationSlots(undefined), [null]);
  assert.deepEqual(locationSlots({}), [null]);
  assert.deepEqual(locationSlots({ locations: [] }), [null]);
});

test("locationSlots : une ville → une case", () => {
  assert.deepEqual(locationSlots({ locations: [{ label: "Paris", radius: 30 }] }), [
    { label: "Paris", radius: 30 },
  ]);
});

test("locationSlots : plusieurs villes → une case par ville (split par lieu)", () => {
  const slots = locationSlots({
    locations: [
      { label: "Paris", radius: 30 },
      { label: "Lyon", radius: 30 },
      { label: "Nantes", radius: null },
    ],
  });
  assert.equal(slots.length, 3);
  assert.deepEqual(
    slots.map((s) => s && s.label),
    ["Paris", "Lyon", "Nantes"],
  );
});
