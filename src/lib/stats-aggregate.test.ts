import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateLocations, OTHERS_LABEL, UNSPECIFIED_LABEL } from "./stats-aggregate";

test("liste vide ⇒ tableau vide", () => {
  assert.deepEqual(aggregateLocations([]), []);
});

test("trie les lieux nommés par volume décroissant", () => {
  const out = aggregateLocations([
    { location: "Lyon", count: 3 },
    { location: "Paris", count: 10 },
    { location: "Nantes", count: 5 },
  ]);
  assert.deepEqual(out, [
    { label: "Paris", count: 10 },
    { label: "Nantes", count: 5 },
    { label: "Lyon", count: 3 },
  ]);
});

test("regroupe la traîne au-delà de topN dans « Autres »", () => {
  const out = aggregateLocations(
    [
      { location: "Paris", count: 10 },
      { location: "Lyon", count: 3 },
      { location: "Nantes", count: 2 },
    ],
    1,
  );
  assert.deepEqual(out, [
    { label: "Paris", count: 10 },
    { label: OTHERS_LABEL, count: 5 },
  ]);
});

test("regroupe null et chaîne vide dans « Non précisé », placé en dernier", () => {
  const out = aggregateLocations([
    { location: "Paris", count: 10 },
    { location: null, count: 5 },
    { location: "", count: 1 },
    { location: "   ", count: 2 },
  ]);
  assert.deepEqual(out, [
    { label: "Paris", count: 10 },
    { label: UNSPECIFIED_LABEL, count: 8 },
  ]);
});

test("ordre final : nommés, puis « Autres », puis « Non précisé »", () => {
  const out = aggregateLocations(
    [
      { location: "Paris", count: 10 },
      { location: "Lyon", count: 4 },
      { location: "Nantes", count: 3 },
      { location: null, count: 6 },
    ],
    1,
  );
  assert.deepEqual(out, [
    { label: "Paris", count: 10 },
    { label: OTHERS_LABEL, count: 7 },
    { label: UNSPECIFIED_LABEL, count: 6 },
  ]);
});

test("aucun seau « Autres » quand tout tient dans topN", () => {
  const out = aggregateLocations([{ location: "Paris", count: 4 }], 8);
  assert.deepEqual(out, [{ label: "Paris", count: 4 }]);
});
