/**
 * `formatRunNotification` : construction PURE du (titre, corps) de la notification
 * bureau de fin de run. Le corps de succès n'affiche QUE le nombre de nouvelles
 * offres (= ce qui entre dans « Toutes »), pas le total trouvé. Couvre pluriel,
 * singulier, zéro, compteur absent, et échec. Le spawn (`notifyDesktop`) n'est
 * pas testé ici (best-effort).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "../shared/types";
import { formatRunNotification } from "./notify";

test("succès : UNIQUEMENT le nombre de nouvelles offres (pluriel)", () => {
  // `found` est volontairement ignoré : la notif ne montre que les nouvelles.
  const r = formatRunNotification({ type: "done", found: 12, newOffers: 3 } as RunEvent);
  assert.match(r.title, /recherche terminée/);
  assert.equal(r.body, "3 nouvelles offres.");
});

test("succès : singulier (1 nouvelle offre, sans 's')", () => {
  const r = formatRunNotification({ type: "done", found: 9, newOffers: 1 } as RunEvent);
  assert.equal(r.body, "1 nouvelle offre.");
});

test("succès : zéro nouvelle → message dédié (même si des offres ont été trouvées)", () => {
  const r = formatRunNotification({ type: "done", found: 40, newOffers: 0 } as RunEvent);
  assert.equal(r.body, "Aucune nouvelle offre.");
});

test("succès : compteur absent → traité comme 0", () => {
  const r = formatRunNotification({ type: "done" } as RunEvent);
  assert.equal(r.body, "Aucune nouvelle offre.");
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
