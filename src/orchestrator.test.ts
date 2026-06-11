/**
 * Test d'intégration de l'orchestration (`runPipeline`).
 *
 * Exerce le cœur du pipeline (fetch concurrent par source → dédup inter-sources
 * → filtre déterministe → persistance) sur une **DB temporaire isolée** et des
 * **sources mockées**. Ne touche JAMAIS la vraie base `data/job-agregator.db`.
 *
 * ⚠️ `JOB_AGREGATOR_DB` est résolu au CHARGEMENT du module `store/sqlite.ts`
 * (constante `DB_PATH` calculée à l'import). On pose donc l'env AVANT tout import
 * du store/pipeline, puis on importe dynamiquement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RawJobOffer } from "./lib/types";
import type { ScrapingSource, FetchOptions } from "./lib/source-interface";
import type { Settings } from "./shared/types";
import type { SearchConfig } from "../config/search.config";

const tmpDir = mkdtempSync(join(tmpdir(), "job-agregator-test-"));
const dbPath = join(tmpDir, "test.db");
process.env.JOB_AGREGATOR_DB = dbPath;

// Imports dynamiques APRÈS avoir posé l'env (sinon DB_PATH pointe sur la vraie base).
const { runPipeline } = await import("./index");
const { initDb, closeDb, listOffers, getStats } = await import("./store/sqlite");

/** Construit une offre brute valide (champs minimaux requis par le pipeline). */
function makeOffer(partial: Partial<RawJobOffer> & { title: string; urlSource: string }): RawJobOffer {
  return {
    title: partial.title,
    company: partial.company ?? "Acme",
    location: partial.location ?? "Paris",
    salary: partial.salary ?? null,
    contractType: partial.contractType ?? null,
    urlSource: partial.urlSource,
    sourceName: partial.sourceName ?? "mock",
    publishedAt: partial.publishedAt ?? null,
  };
}

/** Source mockée : enregistre les options reçues, renvoie des offres (ou throw). */
function mockSource(
  name: string,
  behavior: { kind?: "web" | "ats"; offers?: RawJobOffer[]; throws?: boolean },
  captured?: { options?: FetchOptions },
): ScrapingSource {
  return {
    name,
    kind: behavior.kind,
    async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
      if (captured) captured.options = options;
      if (behavior.throws) throw new Error(`${name} en échec simulé`);
      return behavior.offers ?? [];
    },
  };
}

const baseSettings: Settings = {
  terms: ["data engineer"],
  contractTypes: ["CDI"],
  enabledSources: [],
  atsBoards: {},
};

const baseConfig: SearchConfig = {
  terms: ["data engineer"],
  exclude: [],
  locations: ["Paris", "remote"],
  contractTypes: ["CDI"],
  remote: "any",
};

test("runPipeline : intégration (routage atsBoards, dédup inter-sources, compteurs, best-effort, filtre)", async (t) => {
  initDb();
  t.after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Sources mockées ---------------------------------------------------
  // 1) Source ATS : on vérifie le routage des boards + terms.
  const atsCaptured: { options?: FetchOptions } = {};
  const fakeAts = mockSource(
    "fakeats",
    {
      kind: "ats",
      offers: [
        makeOffer({ title: "Data engineer ATS", company: "AtsCo", urlSource: "https://ats/1" }),
      ],
    },
    atsCaptured,
  );

  // 2+3) Deux sources web renvoyant la MÊME offre logique (title/company/location)
  //      → même hash → doit être dédupliquée entre sources.
  const dupOffer = { title: "Data engineer Dup", company: "DupCo", location: "Paris" };
  const webA = mockSource("weba", {
    kind: "web",
    offers: [makeOffer({ ...dupOffer, urlSource: "https://a/dup" })],
  });
  const webB = mockSource("webb", {
    kind: "web",
    offers: [
      makeOffer({ ...dupOffer, urlSource: "https://b/dup" }), // doublon inter-source
      makeOffer({ title: "Data engineer Unique B", company: "BCo", urlSource: "https://b/uniq" }),
    ],
  });

  // 4) Source qui throw : ne doit PAS casser le run.
  const boom = mockSource("boom", { kind: "web", throws: true });

  // 5) Source dont l'offre doit être REJETÉE par le filtre (titre exclu).
  const excludedSrc = mockSource("excluded", {
    kind: "web",
    offers: [
      makeOffer({ title: "Stagiaire Data engineer", company: "XCo", urlSource: "https://x/stag" }),
    ],
  });

  const sources: ScrapingSource[] = [fakeAts, webA, webB, boom, excludedSrc];

  const settings: Settings = {
    ...baseSettings,
    enabledSources: sources.map((s) => s.name),
    atsBoards: { fakeats: ["acme"] },
  };

  // Config de filtre : exclut "stagiaire" (PAS un contractType sélectionné → bien rejeté).
  const effectiveConfig: SearchConfig = { ...baseConfig, exclude: ["stagiaire"] };

  const events: unknown[] = [];
  const summary = await runPipeline(
    sources,
    settings,
    effectiveConfig,
    false, // dryRun = false : on exerce l'insertion
    (e) => events.push(e),
  );

  // --- 1) Routage atsBoards ---------------------------------------------
  assert.deepEqual(atsCaptured.options?.boards, ["acme"], "la source ATS reçoit ses boards");
  assert.deepEqual(atsCaptured.options?.terms, ["data engineer"], "la source ATS reçoit les terms");

  // --- 3) Compteurs ------------------------------------------------------
  // found = somme des offres brutes : ATS(1) + webA(1) + webB(2) + boom(0) + excluded(1) = 5
  assert.equal(summary.found, 5, "found = somme des offres brutes renvoyées");

  // perSource : nb brut par source (boom = 0 après best-effort).
  assert.equal(summary.perSource.fakeats, 1);
  assert.equal(summary.perSource.weba, 1);
  assert.equal(summary.perSource.webb, 2);
  assert.equal(summary.perSource.boom, 0, "source en échec comptée 0 (best-effort)");
  assert.equal(summary.perSource.excluded, 1);

  // newCount = offres uniques retenues après dédup + filtre :
  //   ATS(1) + dup(1, gardée une fois) + uniqueB(1) = 3 ; l'offre "Stagiaire" est filtrée.
  assert.equal(summary.newCount, 3, "newCount = uniques retenues après dédup+filtre");
  assert.equal(summary.retained, 3, "retained = taille du Map de candidats");

  // --- 2) Dédup inter-sources -------------------------------------------
  assert.ok(summary.duplicates >= 1, "au moins un doublon inter-sources détecté");

  // --- 4) Best-effort : le run se résout malgré la source qui throw -------
  //   (assuré par le fait qu'on atteint ces assertions sans exception)

  // --- 5) Persistance : lecture de la base temp --------------------------
  const offers = listOffers("all", "recent");
  assert.equal(offers.length, 3, "3 offres persistées en base");
  const titles = offers.map((o) => o.title).sort();
  assert.deepEqual(
    titles,
    ["Data engineer ATS", "Data engineer Dup", "Data engineer Unique B"].sort(),
  );
  // L'offre "Stagiaire …" (filtrée) n'est PAS en base.
  assert.ok(!titles.includes("Stagiaire Data engineer"), "offre exclue absente de la base");
  // L'offre dupliquée n'apparaît qu'une fois.
  assert.equal(
    offers.filter((o) => o.title === "Data engineer Dup").length,
    1,
    "offre dédupliquée insérée une seule fois",
  );

  // --- Le dernier run reflète les compteurs (insertRun a lieu dans main(),
  //     pas dans runPipeline) : on vérifie au moins que getStats lit la base temp.
  const stats = getStats();
  assert.equal(stats.bySource.reduce((n, s) => n + s.count, 0), 3, "stats par source = 3 offres");
});
