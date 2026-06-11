import { test } from "node:test";
import assert from "node:assert/strict";
import { ParseReport, type RawScrapeResult, type TrackedField } from "./parse-report";

/** Faux logger qui enregistre les appels par niveau (mêmes signatures que Logger). */
function fakeLogger() {
  const warns: { msg: string; meta?: Record<string, unknown> }[] = [];
  const infos: { msg: string; meta?: Record<string, unknown> }[] = [];
  return {
    warns,
    infos,
    logger: {
      debug() {},
      info(msg: string, meta?: Record<string, unknown>) {
        infos.push({ msg, meta });
      },
      warn(msg: string, meta?: Record<string, unknown>) {
        warns.push({ msg, meta });
      },
      error() {},
    },
  };
}

/** Construit un RawScrapeResult, champs renseignés sauf surcharges null. */
function rawWith(overrides: Partial<RawScrapeResult> = {}): RawScrapeResult {
  return {
    title: "Data Engineer",
    company: "ACME",
    location: "Paris",
    salary: null,
    contractType: "CDI",
    urlSource: "https://x.test/1",
    publishedRaw: null,
    ...overrides,
  };
}

/** Alimente un rapport avec N offres dont les champs ciblés sont null. */
function reportWith(untracked: ReadonlySet<TrackedField> | undefined, n: number, overrides: Partial<RawScrapeResult>) {
  const report = new ParseReport("test", untracked);
  report.addPageDiag({ cardCount: n, dropped: { noTitle: 0, noHref: 0 } });
  for (let i = 0; i < n; i++) {
    report.observe(rawWith(overrides), new Date());
  }
  return report;
}

test("cas 1 — sans untracked : champ null à 100% déclenche le WARN sélecteur cassé", () => {
  const { logger, warns } = fakeLogger();
  const report = reportWith(undefined, 5, { contractType: null });
  report.log(logger);

  const brokenWarns = warns.filter((w) => w.msg.includes("sélecteur probablement cassé"));
  assert.equal(brokenWarns.length, 1);
  assert.ok(brokenWarns[0]?.msg.includes("contractType"));
});

test("cas 2 — untracked ciblé : pas de WARN pour contractType, mais WARN maintenu pour un autre champ", () => {
  const { logger, warns } = fakeLogger();
  // contractType ET company null à 100%, mais seul contractType est neutralisé.
  const report = reportWith(new Set<TrackedField>(["contractType"]), 5, {
    contractType: null,
    company: null,
  });
  report.log(logger);

  const brokenWarns = warns.filter((w) => w.msg.includes("sélecteur probablement cassé"));
  // contractType neutralisé → AUCUN WARN le mentionnant
  assert.ok(!brokenWarns.some((w) => w.msg.includes("contractType")));
  // company NON neutralisé → son WARN subsiste
  assert.equal(brokenWarns.filter((w) => w.msg.includes("company")).length, 1);
});

test("cas 3 — le bilan INFO 'Bilan parsing' avec remplissage reste émis (comptage intact)", () => {
  const { logger, infos } = fakeLogger();
  const report = reportWith(new Set<TrackedField>(["contractType"]), 4, { contractType: null });
  report.log(logger);

  const bilan = infos.find((i) => i.msg === "Bilan parsing");
  assert.ok(bilan, "le bilan INFO doit être émis");
  const remplissage = bilan!.meta?.remplissage as Record<string, string> | undefined;
  assert.ok(remplissage, "remplissage doit être présent");
  // Le champ untracked reste compté : 0/4 (null partout) malgré la neutralisation du WARN.
  assert.equal(remplissage!.contractType, "0/4");
});
