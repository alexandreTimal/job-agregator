/**
 * Test d'intégration : RÉCUPÉRATION de la collecte partielle au timeout.
 *
 * Régression du run du 2026-06-12 : HelloWork avait collecté 175 offres puis
 * dépassé le budget de 600 s ; l'orchestrateur l'a `abort()` et a posé `offers = []`,
 * JETANT les 175 offres que la source restituait pourtant dans son `catch`. Le
 * « filet de sécurité » (hoisting de `allOffers`, catch qui restitue) était du
 * code mort car `withTimeout` rejette puis ignore la valeur tardive de la promesse.
 *
 * Ce test exerce le contrat attendu : au timeout, l'orchestrateur ré-attend la
 * promesse `fetch` (bornée) pour récupérer la collecte partielle restituée à l'abort.
 *
 * ⚠️ Comme orchestrator.test.ts : env posé AVANT import dynamique du store/pipeline.
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

const tmpDir = mkdtempSync(join(tmpdir(), "job-agregator-partial-"));
process.env.JOB_AGREGATOR_DB = join(tmpDir, "test.db");
// Timeout de source minuscule : on déclenche le chemin d'abort sans attendre 600 s.
process.env.JOB_AGREGATOR_SOURCE_TIMEOUT_MS = "50";

const { runPipeline } = await import("./index");
const { initDb, closeDb, listOffers } = await import("./store/sqlite");

function makeOffer(partial: Partial<RawJobOffer> & { title: string; urlSource: string }): RawJobOffer {
  return {
    title: partial.title,
    company: partial.company ?? "Acme",
    location: partial.location ?? "Paris",
    salary: partial.salary ?? null,
    contractType: partial.contractType ?? null,
    urlSource: partial.urlSource,
    sourceName: partial.sourceName ?? "slowpoke",
    publishedAt: partial.publishedAt ?? null,
  };
}

const baseSettings: Settings = {
  terms: ["data engineer"],
  contractTypes: ["CDI"],
  enabledSources: [],
  atsBoards: {},
  salaryMin: 0,
  locations: [],
  remoteOk: false,
  maxOfferAgeDays: 0,
  titleBlacklist: [],
  cronEnabled: false,
  cronTimes: [],
};

const baseConfig: SearchConfig = {
  terms: ["data engineer"],
  exclude: [],
  locations: [],
  contractTypes: ["CDI"],
  remote: "any",
};

test("runPipeline : récupère la collecte partielle d'une source abortée au timeout", async (t) => {
  initDb();
  t.after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Source « lente » à la HelloWork : jamais résolue spontanément dans le délai du
  // test, mais RESTITUE sa collecte partielle dès que le signal d'abort se déclenche.
  const partial = [
    makeOffer({ title: "Data engineer Partiel A", company: "SlowCo", urlSource: "https://slow/a" }),
    makeOffer({ title: "Data engineer Partiel B", company: "SlowCo", urlSource: "https://slow/b" }),
  ];
  const slowpoke: ScrapingSource = {
    name: "slowpoke",
    kind: "web",
    async fetch(options?: FetchOptions): Promise<RawJobOffer[]> {
      return await new Promise<RawJobOffer[]>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(partial));
        // pas de résolution spontanée : seul l'abort débloque (simule la lenteur)
      });
    },
  };

  const settings: Settings = { ...baseSettings, enabledSources: ["slowpoke"] };

  const summary = await runPipeline(
    [slowpoke],
    settings,
    baseConfig,
    false,
    () => {},
  );

  // La collecte partielle restituée à l'abort doit être COMPTÉE, pas jetée.
  assert.equal(summary.perSource.slowpoke, 2, "les offres partielles de la source abortée sont récupérées");
  assert.equal(summary.found, 2, "found inclut la collecte partielle");
  assert.equal(summary.newCount, 2, "les offres partielles sont retenues après filtre");

  const offers = listOffers("all", "recent");
  assert.equal(offers.length, 2, "les offres partielles sont persistées en base");
});
