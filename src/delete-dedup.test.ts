/**
 * Dédup & suppression : la clé de dédup est `title + company` (le lieu est
 * volontairement EXCLU). Une offre supprimée (clic poubelle) ne doit pas
 * réapparaître même si un re-post revient avec un lieu légèrement différent.
 *
 * ⚠️ `JOB_AGREGATOR_DB` est résolu au CHARGEMENT de `store/sqlite.ts` : on pose
 * l'env AVANT tout import du store/pipeline, puis on importe dynamiquement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeHash } from "./lib/normalize";
import type { RawJobOffer } from "./lib/types";
import type { ScrapingSource, FetchOptions } from "./lib/source-interface";
import type { Settings, RunEvent } from "./shared/types";
import type { SearchConfig } from "../config/search.config";

// --- Test unitaire : la clé = titre + entreprise (insensible casse/accents) ---
test("computeHash : même titre+entreprise (casse/accents variés) → même hash", () => {
  const a = computeHash({ title: "Data Engineer (H/F)", company: "Acme" });
  const b = computeHash({ title: "data engineer (h/f)", company: "ACME" });
  assert.equal(a, b, "casse/accents ne doivent pas changer le hash");

  const c = computeHash({ title: "Data Engineer", company: "Globex" });
  assert.notEqual(a, c, "un titre+entreprise différent donne un hash différent");
});

// --- Test d'intégration : suppression persistante malgré re-post variant ---
const tmpDir = mkdtempSync(join(tmpdir(), "job-agregator-del-"));
process.env.JOB_AGREGATOR_DB = join(tmpDir, "test.db");

const { runPipeline } = await import("./index");
const { initDb, closeDb, listOffers, setDeleted, getDb } = await import("./store/sqlite");

function makeOffer(p: Partial<RawJobOffer> & { title: string; urlSource: string }): RawJobOffer {
  return {
    title: p.title,
    company: p.company ?? "Acme",
    location: p.location ?? "Paris",
    salary: p.salary ?? null,
    contractType: p.contractType ?? null,
    urlSource: p.urlSource,
    sourceName: p.sourceName ?? "mock",
    publishedAt: p.publishedAt ?? null,
  };
}

const mockSource = (offers: RawJobOffer[]): ScrapingSource => ({
  name: "mock",
  kind: "web",
  async fetch(_options?: FetchOptions): Promise<RawJobOffer[]> {
    return offers;
  },
});

const settings: Settings = {
  terms: ["data engineer"],
  contractTypes: ["CDI"],
  enabledSources: ["mock"],
  atsBoards: {},
  salaryMin: 0,
  locations: [],
  remoteOk: false,
  maxOfferAgeDays: 0,
  cronEnabled: false,
  cronTimes: [],
};

const cfg: SearchConfig = {
  terms: ["data engineer"],
  exclude: [],
  locations: ["Paris", "remote"],
  contractTypes: ["CDI"],
  remote: "any",
};
const sink = (_e: RunEvent) => {};

test("offre supprimée ne revient pas, même si le re-post change de lieu", async (t) => {
  initDb();
  t.after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // RUN 1 : lieu « Paris ».
  const r1 = await runPipeline(
    [mockSource([makeOffer({ title: "Data engineer", company: "Acme", location: "Paris", urlSource: "https://x/1" })])],
    settings,
    cfg,
    false,
    sink,
  );
  assert.equal(r1.newCount, 1, "run 1 : 1 nouvelle offre");
  const v1 = listOffers("all", "recent");
  assert.equal(v1.length, 1, "run 1 : 1 offre visible");
  const cible = v1[0];
  assert.ok(cible, "offre présente");

  // CLIC POUBELLE : soft-delete.
  setDeleted(cible.id);
  assert.equal(listOffers("all", "recent").length, 0, "après suppression : invisible");

  // RUN 2 : MÊME poste, lieu « Paris 9e » et URL différente (re-post).
  const r2 = await runPipeline(
    [mockSource([makeOffer({ title: "Data engineer", company: "Acme", location: "Paris 9e", urlSource: "https://x/2" })])],
    settings,
    cfg,
    false,
    sink,
  );
  assert.equal(r2.newCount, 0, "run 2 : aucune nouvelle offre (reconnue comme doublon)");
  assert.equal(r2.duplicates, 1, "run 2 : comptée comme doublon");
  assert.equal(listOffers("all", "recent").length, 0, "run 2 : l'offre supprimée NE revient PAS");

  const n = (getDb().prepare("SELECT COUNT(*) n FROM seen_offers").get() as { n: number }).n;
  assert.equal(n, 1, "une seule ligne en base (pas de duplicat malgré la variation de lieu)");
});
