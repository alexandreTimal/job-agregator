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
import type { Settings, RunEvent } from "./shared/types";
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
  maxOfferAgeDays: 0,
  // Champs cron (requis par le type `Settings`) : neutres pour ce test d'orchestration.
  cronEnabled: false,
  cronTimes: [],
};

/** Date de publication il y a `n` jours (relatif à maintenant). */
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

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

  // 6) Source exerçant le filtre d'âge : une offre récente (gardée) + une trop
  //    ancienne (écartée par maxOfferAgeDays). Les autres offres ont publishedAt
  //    null → lenient → insensibles au filtre d'âge.
  const ageSrc = mockSource("freshness", {
    kind: "web",
    offers: [
      makeOffer({
        title: "Data engineer Recent",
        company: "FreshCo",
        urlSource: "https://f/recent",
        publishedAt: daysAgo(1),
      }),
      makeOffer({
        title: "Data engineer Old",
        company: "OldCo",
        urlSource: "https://f/old",
        publishedAt: daysAgo(30),
      }),
    ],
  });

  const sources: ScrapingSource[] = [fakeAts, webA, webB, boom, excludedSrc, ageSrc];

  const settings: Settings = {
    ...baseSettings,
    enabledSources: sources.map((s) => s.name),
    atsBoards: { fakeats: ["acme"] },
  };

  // Config de filtre : exclut "stagiaire" (PAS un contractType sélectionné → bien rejeté)
  // et n'accepte que les offres de moins de 7 jours (filtre d'ancienneté).
  const effectiveConfig: SearchConfig = {
    ...baseConfig,
    exclude: ["stagiaire"],
    maxOfferAgeDays: 7,
  };

  const events: RunEvent[] = [];
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
  // found = somme des offres brutes :
  //   ATS(1) + webA(1) + webB(2) + boom(0) + excluded(1) + freshness(2) = 7
  assert.equal(summary.found, 7, "found = somme des offres brutes renvoyées");

  // perSource : nb brut par source (boom = 0 après best-effort).
  assert.equal(summary.perSource.fakeats, 1);
  assert.equal(summary.perSource.weba, 1);
  assert.equal(summary.perSource.webb, 2);
  assert.equal(summary.perSource.boom, 0, "source en échec comptée 0 (best-effort)");
  assert.equal(summary.perSource.excluded, 1);
  assert.equal(summary.perSource.freshness, 2);

  // newCount = offres uniques retenues après dédup + filtre :
  //   ATS(1) + dup(1, gardée une fois) + uniqueB(1) + Recent(1) = 4.
  //   Filtrées : "Stagiaire" (exclude) et "Old" (ancienneté > 7 j).
  assert.equal(summary.newCount, 4, "newCount = uniques retenues après dédup+filtre");
  assert.equal(summary.retained, 4, "retained = taille du Map de candidats");

  // --- 2) Dédup inter-sources -------------------------------------------
  assert.ok(summary.duplicates >= 1, "au moins un doublon inter-sources détecté");

  // --- 4) Best-effort : le run se résout malgré la source qui throw -------
  //   (assuré par le fait qu'on atteint ces assertions sans exception)

  // --- Progression : flux d'événements destiné à l'UI --------------------
  const progressEvents = events.filter((e) => e.type === "progress");
  const startEvents = progressEvents.filter((e) => e.phase === "start");
  assert.equal(startEvents.length, 1, "un seul événement de lancement");
  const start = startEvents[0];
  assert.ok(start, "un événement de lancement émis");
  assert.equal(start.totalSources, 6, "start annonce le nombre de sources");
  assert.equal(start.totalTerms, 1, "start annonce le nombre de termes");

  const doneEvents = progressEvents.filter((e) => e.phase === "source-done");
  assert.equal(doneEvents.length, 6, "un source-done par source (y compris celle en échec)");
  assert.equal(
    Math.max(...doneEvents.map((e) => e.sourcesDone ?? 0)),
    6,
    "le compteur de progression atteint N/N",
  );
  const boomDone = doneEvents.find((e) => e.source === "boom");
  assert.equal(
    boomDone?.found,
    0,
    "la source en échec émet quand même son source-done (best-effort)",
  );

  // --- 5) Persistance : lecture de la base temp --------------------------
  const offers = listOffers("all", "recent");
  assert.equal(offers.length, 4, "4 offres persistées en base");
  const titles = offers.map((o) => o.title).sort();
  assert.deepEqual(
    titles,
    ["Data engineer ATS", "Data engineer Dup", "Data engineer Recent", "Data engineer Unique B"].sort(),
  );
  // L'offre "Stagiaire …" (filtrée) n'est PAS en base.
  assert.ok(!titles.includes("Stagiaire Data engineer"), "offre exclue absente de la base");
  // L'offre "… Old" (trop ancienne) n'est PAS en base (filtre d'ancienneté).
  assert.ok(!titles.includes("Data engineer Old"), "offre trop ancienne absente de la base");
  // L'offre dupliquée n'apparaît qu'une fois.
  assert.equal(
    offers.filter((o) => o.title === "Data engineer Dup").length,
    1,
    "offre dédupliquée insérée une seule fois",
  );

  // --- Le dernier run reflète les compteurs (insertRun a lieu dans main(),
  //     pas dans runPipeline) : on vérifie au moins que getStats lit la base temp.
  const stats = getStats();
  assert.equal(stats.bySource.reduce((n, s) => n + s.count, 0), 4, "stats par source = 4 offres");
});
