import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidTime,
  parseTimes,
  nextFireDelay,
  previousSlot,
  shouldCatchUp,
} from "./cron-schedule";

/** Construit une Date locale à HH:MM:SS.mmm le 2026-06-11 (jour arbitraire). */
function at(h: number, m: number, s = 0, ms = 0): Date {
  return new Date(2026, 5, 11, h, m, s, ms);
}

const MIN = 60_000;
const DAY = 86_400_000;

test("isValidTime accepte les bornes et rejette le hors-format", () => {
  for (const ok of ["00:00", "08:00", "20:00", "23:59"]) {
    assert.equal(isValidTime(ok), true, ok);
  }
  for (const ko of ["24:00", "08:60", "8:00", "08:0", "0800", "", "ab:cd", 800]) {
    assert.equal(isValidTime(ko as unknown), false, String(ko));
  }
});

test("parseTimes filtre l'invalide, convertit en minutes, trie et déduplique", () => {
  assert.deepEqual(parseTimes(["20:00", "08:00", "08:00", "bad", "23:59"]), [
    8 * 60,
    20 * 60,
    23 * 60 + 59,
  ]);
  assert.deepEqual(parseTimes([]), []);
  assert.deepEqual(parseTimes(["nope"]), []);
});

test("nextFireDelay vise le prochain créneau plus tard dans la journée", () => {
  // 07:00 → prochain = 08:00 (1h).
  assert.equal(nextFireDelay(at(7, 0), ["08:00", "20:00"]), 60 * MIN);
  // 09:00 → prochain = 20:00 (11h).
  assert.equal(nextFireDelay(at(9, 0), ["08:00", "20:00"]), 11 * 60 * MIN);
});

test("nextFireDelay bascule au lendemain quand tous les créneaux sont passés", () => {
  // 21:00, dernier créneau 20:00 passé → 08:00 demain = 11h.
  assert.equal(nextFireDelay(at(21, 0), ["08:00", "20:00"]), 11 * 60 * MIN);
});

test("nextFireDelay traite l'égalité exacte comme passée (pas de re-fire immédiat)", () => {
  // Exactement 08:00:00.000 → on saute à 20:00 (12h), pas 0.
  assert.equal(nextFireDelay(at(8, 0, 0, 0), ["08:00", "20:00"]), 12 * 60 * MIN);
  // Un seul créneau, atteint pile → lendemain (24h).
  assert.equal(nextFireDelay(at(8, 0, 0, 0), ["08:00"]), DAY);
});

test("nextFireDelay tient compte des secondes/millisecondes", () => {
  // 07:59:30.000 → 08:00 dans 30s.
  assert.equal(nextFireDelay(at(7, 59, 30, 0), ["08:00"]), 30_000);
  // 07:59:59.500 → 08:00 dans 500ms.
  assert.equal(nextFireDelay(at(7, 59, 59, 500), ["08:00"]), 500);
});

test("nextFireDelay renvoie null sans horaire valide", () => {
  assert.equal(nextFireDelay(at(10, 0), []), null);
  assert.equal(nextFireDelay(at(10, 0), ["bad", "25:00"]), null);
});

test("nextFireDelay accepte une liste non triée", () => {
  // 12:00, créneaux désordonnés → prochain = 20:00 (8h).
  assert.equal(nextFireDelay(at(12, 0), ["20:00", "06:00", "08:00"]), 8 * 60 * MIN);
});

test("previousSlot renvoie le dernier créneau écoulé aujourd'hui", () => {
  // 09:00 → dernier créneau passé = 08:00 aujourd'hui.
  assert.deepEqual(previousSlot(at(9, 0), ["08:00", "20:00"]), at(8, 0));
  // 21:00 → 20:00 aujourd'hui.
  assert.deepEqual(previousSlot(at(21, 0), ["08:00", "20:00"]), at(20, 0));
});

test("previousSlot bascule à hier quand aucun créneau n'est encore passé", () => {
  // 07:00, premier créneau 08:00 pas encore atteint → 20:00 hier (10 juin).
  assert.deepEqual(
    previousSlot(at(7, 0), ["08:00", "20:00"]),
    new Date(2026, 5, 10, 20, 0),
  );
});

test("previousSlot traite l'égalité exacte comme écoulée", () => {
  // Pile 08:00:00.000 → ce créneau compte comme passé.
  assert.deepEqual(previousSlot(at(8, 0, 0, 0), ["08:00", "20:00"]), at(8, 0));
});

test("previousSlot renvoie null sans horaire valide", () => {
  assert.equal(previousSlot(at(10, 0), []), null);
  assert.equal(previousSlot(at(10, 0), ["bad"]), null);
});

test("shouldCatchUp détecte un créneau manqué pendant l'extinction", () => {
  // Dernier run hier 20:05, allumage aujourd'hui 09:00 : 08:00 manqué → rattrapage.
  const lastRun = new Date(2026, 5, 10, 20, 5);
  assert.equal(shouldCatchUp(lastRun, at(9, 0), ["08:00", "20:00"]), true);
});

test("shouldCatchUp ne rattrape pas si le dernier run couvre le dernier créneau", () => {
  // Run à 08:10 aujourd'hui, on est à 09:00 : 08:00 déjà couvert → pas de rattrapage.
  const lastRun = at(8, 10);
  assert.equal(shouldCatchUp(lastRun, at(9, 0), ["08:00", "20:00"]), false);
});

test("shouldCatchUp rattrape au premier boot (jamais tourné) si un créneau est passé", () => {
  assert.equal(shouldCatchUp(null, at(9, 0), ["08:00", "20:00"]), true);
  // Avant tout créneau du jour ET jamais tourné → vise le créneau d'hier, donc rattrape.
  assert.equal(shouldCatchUp(null, at(7, 0), ["08:00", "20:00"]), true);
});

test("shouldCatchUp est faux sans horaire valide", () => {
  assert.equal(shouldCatchUp(null, at(9, 0), []), false);
});
