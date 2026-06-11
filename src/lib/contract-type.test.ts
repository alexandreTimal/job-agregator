import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyContractType } from "./contract-type";

test("classe depuis le titre : « Stage » ⇒ stage", () => {
  assert.equal(classifyContractType("Stage Data Analyst", null), "stage");
});

test("classe depuis le titre : « Stagiaire » ⇒ stage", () => {
  assert.equal(classifyContractType("Stagiaire développement web", null), "stage");
});

test("classe depuis le titre : « Alternance » ⇒ stage", () => {
  assert.equal(classifyContractType("Alternance Développeur Backend", null), "stage");
});

test("classe depuis le titre : « apprentissage » ⇒ stage", () => {
  assert.equal(classifyContractType("Contrat d'apprentissage Marketing", null), "stage");
});

test("le raw prime quand présent : raw « Internship » ⇒ stage", () => {
  assert.equal(classifyContractType("Data Analyst", "Internship"), "stage");
});

test("défaut CDI : titre neutre, raw absent", () => {
  assert.equal(classifyContractType("Développeur Backend", null), "CDI");
});

test("défaut CDI : raw « Full-time » ⇒ CDI", () => {
  assert.equal(classifyContractType("Data Analyst", "Full-time"), "CDI");
});

test("pas de faux positif de sous-chaîne : « International » ⇒ CDI", () => {
  // « international » contient « intern » mais le match par préfixe de token
  // exige « internship » entier → ne doit PAS être classé stage.
  assert.equal(classifyContractType("International Sales Manager", null), "CDI");
});

test("insensible aux accents et à la casse", () => {
  assert.equal(classifyContractType("STAGE — Chargé de Communication", null), "stage");
});
