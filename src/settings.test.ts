/**
 * Profils de recherche (`src/settings.ts`).
 *
 * Vérifie : seed/migration paresseuse, résolution du profil actif par
 * `getSettings`, écriture CIBLÉE par `setSettings` (les autres profils intacts),
 * et le cycle create(clone)/rename/activate/delete avec ses cas d'erreur.
 *
 * ⚠️ `JOB_AGREGATOR_DB` est résolu au CHARGEMENT de `store/sqlite.ts` : on pose
 * l'env AVANT tout import du store/settings, puis on importe dynamiquement. La
 * table `settings` est remise à zéro avant chaque test (DB partagée par fichier).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "job-agregator-settings-"));
process.env.JOB_AGREGATOR_DB = join(tmpDir, "test.db");

const { initDb, getDb, setSettingRaw } = await import("./store/sqlite");
const {
  getSettings,
  setSettings,
  listProfiles,
  createProfile,
  renameProfile,
  activateProfile,
  deleteProfile,
  ProfileError,
} = await import("./settings");

initDb();

/** Remet la table `settings` à zéro → simule une base fraîche. */
beforeEach(() => {
  getDb().prepare("DELETE FROM settings").run();
});

test("base fraîche : seed crée un unique profil « Par défaut » actif", () => {
  const state = listProfiles();
  assert.equal(state.profiles.length, 1);
  assert.equal(state.activeProfileId, "default");
  assert.equal(state.profiles[0]?.id, "default");
  assert.equal(state.profiles[0]?.name, "Par défaut");
});

test("migration paresseuse : critères plats pré-profils → profil « Par défaut »", () => {
  // Base PRÉ-profils : des clés plates existent mais aucune clé `searchProfiles`.
  setSettingRaw("terms", JSON.stringify(["custom term"]));
  setSettingRaw("salaryMin", "33000");

  const settings = getSettings();
  assert.deepEqual(settings.terms, ["custom term"], "les termes plats sont migrés");
  assert.equal(settings.salaryMin, 33000, "le salaire plat est migré");

  const state = listProfiles();
  assert.equal(state.profiles.length, 1);
  assert.equal(state.activeProfileId, "default");
});

test("getSettings résout les critères du profil ACTIF", () => {
  getSettings(); // seed
  const meta = createProfile("Stage ML");
  activateProfile(meta.id);

  const base = getSettings();
  setSettings({ ...base, terms: ["ml engineer"], salaryMin: 40000 });

  const resolved = getSettings();
  assert.deepEqual(resolved.terms, ["ml engineer"]);
  assert.equal(resolved.salaryMin, 40000);
});

test("setSettings n'écrit QUE le profil actif (les autres intacts)", () => {
  const seeded = getSettings();
  const defaultTerms = seeded.terms;

  const b = createProfile("Profil B"); // clone du défaut, NON activé
  activateProfile(b.id);
  setSettings({ ...getSettings(), terms: ["b-term"] });

  // Le profil B porte b-term…
  assert.deepEqual(getSettings().terms, ["b-term"]);

  // …et le profil par défaut est resté tel quel.
  activateProfile("default");
  assert.deepEqual(getSettings().terms, defaultTerms, "le profil par défaut n'a pas bougé");
});

test("cron reste GLOBAL (partagé entre profils)", () => {
  getSettings();
  setSettings({ ...getSettings(), cronEnabled: true, cronTimes: ["09:30"] });

  const b = createProfile("Profil B");
  activateProfile(b.id);
  const onB = getSettings();
  assert.equal(onB.cronEnabled, true, "cronEnabled est commun");
  assert.deepEqual(onB.cronTimes, ["09:30"], "cronTimes est commun");
});

test("createProfile clone les critères du profil actif et ne l'active pas", () => {
  setSettings({ ...getSettings(), terms: ["source term"] });
  const before = listProfiles().activeProfileId;

  const meta = createProfile("Clone");
  assert.equal(listProfiles().activeProfileId, before, "création n'active pas le nouveau profil");

  activateProfile(meta.id);
  assert.deepEqual(getSettings().terms, ["source term"], "le nouveau profil clone les critères");
});

test("renameProfile met à jour le libellé", () => {
  getSettings();
  renameProfile("default", "Renommé");
  assert.equal(listProfiles().profiles.find((p) => p.id === "default")?.name, "Renommé");
});

test("deleteProfile : suppression de l'actif réaffecte un autre profil", () => {
  getSettings();
  const b = createProfile("B"); // p1
  deleteProfile("default"); // default était actif
  const state = listProfiles();
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0]?.id, b.id);
  assert.equal(state.activeProfileId, b.id, "un profil restant devient actif");
});

test("id de profil : un id supprimé n'est JAMAIS ré-affecté (compteur monotone)", () => {
  getSettings();
  const a = createProfile("A"); // p1 (plus haut numéro)
  deleteProfile(a.id); // on supprime le plus haut numéro…
  const b = createProfile("B"); // …le suivant ne doit pas réutiliser p1
  assert.notEqual(b.id, a.id, "l'id du profil supprimé ne doit pas être réattribué");
});

test("readProfiles : activeProfileId manquant ne détruit pas une liste valide", () => {
  getSettings();
  const a = createProfile("A");
  activateProfile(a.id);
  // Simule une écriture interrompue : on efface la clé activeProfileId.
  getDb().prepare("DELETE FROM settings WHERE key = 'activeProfileId'").run();
  const state = listProfiles();
  assert.equal(state.profiles.length, 2, "les profils existants sont préservés");
  assert.equal(state.activeProfileId, "default", "l'actif retombe sur le 1er profil");
});

test("deleteProfile refuse de supprimer le DERNIER profil", () => {
  getSettings();
  assert.throws(
    () => deleteProfile("default"),
    (err: unknown) => err instanceof ProfileError && err.code === "LAST_PROFILE",
  );
});

test("erreurs métier : NOT_FOUND et INVALID_NAME", () => {
  getSettings();
  assert.throws(
    () => activateProfile("zzz"),
    (err: unknown) => err instanceof ProfileError && err.code === "NOT_FOUND",
  );
  assert.throws(
    () => renameProfile("zzz", "X"),
    (err: unknown) => err instanceof ProfileError && err.code === "NOT_FOUND",
  );
  assert.throws(
    () => createProfile("   "),
    (err: unknown) => err instanceof ProfileError && err.code === "INVALID_NAME",
  );
});

test("activateProfile sur un id inexistant ne casse pas l'état (actif inchangé)", () => {
  getSettings();
  const before = listProfiles().activeProfileId;
  try {
    activateProfile("ghost");
  } catch {
    /* attendu */
  }
  assert.equal(listProfiles().activeProfileId, before);
});
