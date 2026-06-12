/**
 * `listOffers` — sémantique des filtres après triage.
 *
 * « Toutes » (`all`) est la boîte des offres NON triées : ni likées, ni
 * postulées (ni supprimées). Liker → l'offre passe dans « Favoris » (`liked`),
 * postuler → dans « Postulées » (`applied`). Une offre likée ET postulée
 * apparaît dans les deux onglets, jamais dans « Toutes ».
 *
 * ⚠️ `JOB_AGREGATOR_DB` est résolu au CHARGEMENT de `store/sqlite.ts` : on pose
 * l'env AVANT tout import du store, puis on importe dynamiquement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "job-agregator-filter-"));
process.env.JOB_AGREGATOR_DB = join(tmpDir, "test.db");

const { initDb, closeDb, getDb, insertOffer, listOffers, setLiked, setApplied, setDeleted } =
  await import("./sqlite");

/** Insère une offre (hash unique) et renvoie son id. */
function seed(title: string): number {
  const hash = `hash-${title}`;
  insertOffer({
    hash,
    title,
    company: "Acme",
    url: `https://x/${title}`,
    source: "mock",
    score: 0,
  });
  const row = getDb().prepare("SELECT id FROM seen_offers WHERE hash = ?").get(hash) as { id: number };
  return row.id;
}

const ids = (offers: { id: number }[]) => offers.map((o) => o.id).sort((a, b) => a - b);

test("listOffers : le triage déplace les offres hors de « Toutes »", (t) => {
  initDb();
  t.after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const untriaged = seed("untriaged");
  const liked = seed("liked");
  const applied = seed("applied");
  const both = seed("both");
  const deleted = seed("deleted");

  setLiked(liked, true);
  setApplied(applied, true);
  setLiked(both, true);
  setApplied(both, true);
  setDeleted(deleted);

  // « Toutes » : uniquement l'offre non triée et non supprimée.
  assert.deepEqual(ids(listOffers("all", "recent")), [untriaged], "all = ni likée ni postulée ni supprimée");

  // « Favoris » : likée seule + likée+postulée.
  assert.deepEqual(ids(listOffers("liked", "recent")), ids([{ id: liked }, { id: both }]), "liked = toutes les likées");

  // « Postulées » : postulée seule + likée+postulée.
  assert.deepEqual(
    ids(listOffers("applied", "recent")),
    ids([{ id: applied }, { id: both }]),
    "applied = toutes les postulées",
  );
});
