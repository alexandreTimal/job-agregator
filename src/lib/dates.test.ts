import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePublishedAt, addBusinessDays } from "./dates";

/** Raccourci : composante date (YYYY-MM-DD) en UTC, ou null. */
function ymd(raw: string | null): string | null {
  const d = parsePublishedAt(raw);
  return d ? d.toISOString().slice(0, 10) : null;
}

test("ISO / datetime absolu", () => {
  assert.equal(ymd("2026-06-10T08:00:00Z"), "2026-06-10");
  assert.equal(ymd("2026-06-10"), "2026-06-10");
});

test("dates absolues françaises (mois plein)", () => {
  assert.equal(ymd("21 mai 2026"), "2026-05-21");
  assert.equal(ymd("3 décembre 2025"), "2025-12-03");
  assert.equal(ymd("15 août 2024"), "2024-08-15");
});

test("dates absolues françaises abrégées (anglo-compatibles incluses)", () => {
  // « sept. » / « janv. » : V8 les mal-interprétait via new Date() avant le fix.
  assert.equal(ymd("1 sept. 2025"), "2025-09-01");
  assert.equal(ymd("30 janv. 2026"), "2026-01-30");
  assert.equal(ymd("5 févr. 2026"), "2026-02-05");
});

test("formes relatives françaises", () => {
  // On n'assert que la cohérence relative (dépend de l'heure courante).
  assert.ok(parsePublishedAt("aujourd'hui"));
  assert.ok(parsePublishedAt("hier"));
  assert.ok(parsePublishedAt("il y a 6 heures"));
  assert.ok(parsePublishedAt("il y a 2 semaines"));
});

test("« avant-hier » = J-2, distinct de « hier » (J-1)", () => {
  // Régression : `\bhier\b` matche aussi le « hier » d'« avant-hier ». On vérifie
  // que la branche dédiée le résout bien à J-2 et non J-1.
  const ajd = parsePublishedAt("aujourd'hui")!;
  const hier = parsePublishedAt("hier")!;
  const avantHier = parsePublishedAt("avant-hier")!;
  assert.ok(avantHier);
  const JOUR = 24 * 60 * 60 * 1000;
  const joursEntre = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / JOUR);
  assert.equal(joursEntre(ajd, hier), 1);
  assert.equal(joursEntre(ajd, avantHier), 2);
  assert.equal(joursEntre(hier, avantHier), 1);
});

test("non-dates → null (pas de faux positif)", () => {
  assert.equal(ymd("1,3K à 1,6K €par mois"), null); // « mois » du salaire ≠ date
  assert.equal(ymd("Stage"), null);
  assert.equal(ymd(""), null);
  assert.equal(ymd(null), null);
});

/** Raccourci : +N jours ouvrables sur une date UTC, composante jour (YYYY-MM-DD). */
function plusOuvres(isoDay: string, days: number): string {
  return addBusinessDays(new Date(`${isoDay}T10:00:00Z`), days).toISOString().slice(0, 10);
}

test("addBusinessDays — saute le week-end (cas de la matrice)", () => {
  // Jeudi 11 juin 2026 +3 ouvrés → mardi 16 (saute sam 13 + dim 14).
  assert.equal(plusOuvres("2026-06-11", 3), "2026-06-16");
  // Vendredi 12 juin +3 ouvrés → mercredi 17 (saute sam 13 + dim 14).
  assert.equal(plusOuvres("2026-06-12", 3), "2026-06-17");
  // Lundi 8 juin +3 ouvrés → jeudi 11 (semaine pleine, aucun week-end).
  assert.equal(plusOuvres("2026-06-08", 3), "2026-06-11");
});

test("addBusinessDays — départ un week-end : comptage dès lundi", () => {
  // Samedi 13 juin +3 ouvrés → lun/mar/mer → mercredi 17.
  assert.equal(plusOuvres("2026-06-13", 3), "2026-06-17");
  // Dimanche 14 juin +3 ouvrés → mercredi 17.
  assert.equal(plusOuvres("2026-06-14", 3), "2026-06-17");
});

test("addBusinessDays — 0 jour rend le jour même (ancré midi UTC)", () => {
  const d = addBusinessDays(new Date("2026-06-11T23:30:00Z"), 0);
  assert.equal(d.toISOString().slice(0, 10), "2026-06-11");
  assert.equal(d.getUTCHours(), 12);
});
