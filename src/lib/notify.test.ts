/**
 * `formatRunNotification` : construction PURE du (titre, corps) de la notification
 * bureau de fin de run. Couvre succès (bilan + pluralisation FR), zéro offre, et
 * échec. Le côté spawn (`notifyDesktop`) reste best-effort non testé ici.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "../shared/types";
import { formatRunNotification } from "./notify";

test("succès : bilan « trouvées · nouvelles » avec pluriels", () => {
  const r = formatRunNotification({ type: "done", found: 12, newOffers: 3 } as RunEvent);
  assert.match(r.title, /recherche terminée/);
  assert.equal(r.body, "12 offres trouvées · 3 nouvelles.");
});

test("succès : singulier (1 trouvée · 1 nouvelle, sans 's')", () => {
  const r = formatRunNotification({ type: "done", found: 1, newOffers: 1 } as RunEvent);
  assert.equal(r.body, "1 offre trouvée · 1 nouvelle.");
});

test("succès : zéro offre trouvée → message dédié", () => {
  const r = formatRunNotification({ type: "done", found: 0, newOffers: 0 } as RunEvent);
  assert.equal(r.body, "Aucune offre trouvée.");
});

test("succès : compteurs absents → traités comme 0", () => {
  const r = formatRunNotification({ type: "done" } as RunEvent);
  assert.equal(r.body, "Aucune offre trouvée.");
});

test("échec : titre d'échec + message d'erreur", () => {
  const r = formatRunNotification({ type: "error", message: "boom" } as RunEvent);
  assert.match(r.title, /échec/);
  assert.equal(r.body, "boom");
});

test("échec sans message → repli « Erreur inconnue. »", () => {
  const r = formatRunNotification({ type: "error" } as RunEvent);
  assert.equal(r.body, "Erreur inconnue.");
});
