/**
 * Runner du banc d'essai : exécute UN triplet (variante, offre, run) et émet ses
 * métriques. Usage : tsx bench.ts <control|A|B> <offerId> <outDir>
 *
 * Émet sur stdout une ligne `@@FITBENCH <json>` et écrit <outDir>/result.json.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureEnv, getOffer, spawnClaude, measure, parseTrace, type Offer } from "./lib.ts";
import {
  buildControlPrompt, buildVariantAPrompt,
  buildVariantB_tailoring, buildVariantB_fit, buildVariantB_letter,
  type Paths,
} from "./prompts.ts";

const BASE_TOOLS = ["Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "TodoWrite"];

interface StepLog { step: string; code: number | null; durationMs: number; }

interface QualityChecks { headersEmitted: boolean; agregatorEntry: boolean; orderOk: boolean | null; nbExperiences: number; }

/** Checks statiques sur le JSON produit (indépendants du fit). */
function qualityChecks(jsonPath: string): QualityChecks {
  const empty: QualityChecks = { headersEmitted: false, agregatorEntry: false, orderOk: null, nbExperiences: 0 };
  if (!existsSync(jsonPath)) return empty;
  let d: any;
  try { d = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { return empty; }
  const headersEmitted = Object.keys(d).some((k) => k.startsWith("h_"));
  const exp: any[] = Array.isArray(d.experience) ? d.experience : [];
  const isAgg = (e: any) => /agr[ée]gateur|projet personnel/i.test(`${e.org ?? ""} ${e.role ?? ""}`);
  const agregatorEntry = exp.some(isAgg);
  const ongoing = (e: any) => /pr[ée]sent|aujourd/i.test(String(e.date ?? ""));
  // orderOk : aucun "en cours" ne doit apparaître APRÈS une expérience terminée.
  let orderOk: boolean | null = null;
  if (exp.length > 1) {
    orderOk = true;
    let seenFinished = false;
    for (const e of exp) {
      if (ongoing(e)) { if (seenFinished) { orderOk = false; break; } }
      else seenFinished = true;
    }
  }
  return { headersEmitted, agregatorEntry, orderOk, nbExperiences: exp.length };
}

async function runStep(label: string, prompt: string, tools: string[], logFile: string): Promise<StepLog> {
  const startMs = Date.now();
  const r = await spawnClaude({ prompt, allowedTools: tools, logFile, startMs });
  return { step: label, code: r.code, durationMs: r.durationMs };
}

async function main() {
  const [variant, offerIdRaw, outDir] = process.argv.slice(2);
  if (!variant || !offerIdRaw || !outDir) {
    console.error("usage: tsx bench.ts <control|A|B> <offerId> <outDir>");
    process.exit(2);
  }
  const offerId = Number(offerIdRaw);
  ensureEnv();
  const offer: Offer = getOffer(offerId);
  mkdirSync(outDir, { recursive: true });
  const p: Paths = { json: resolve(outDir, "cv-offre.json"), cv: resolve(outDir, "cv.pdf"), lettre: resolve(outDir, "lettre.md") };
  const logFile = resolve(outDir, "agent.log");

  const steps: StepLog[] = [];
  if (variant === "control") {
    steps.push(await runStep("monolith", buildControlPrompt(offer, p), BASE_TOOLS, logFile));
  } else if (variant === "A") {
    steps.push(await runStep("monolith+subagent", buildVariantAPrompt(offer, p), [...BASE_TOOLS, "Agent"], logFile));
  } else if (variant === "B") {
    steps.push(await runStep("B1-tailoring", buildVariantB_tailoring(offer, p), BASE_TOOLS, logFile));
    if (existsSync(p.json)) {
      steps.push(await runStep("B2-fit", buildVariantB_fit(p), BASE_TOOLS, logFile));
      steps.push(await runStep("B3-letter", buildVariantB_letter(offer, p), BASE_TOOLS, logFile));
    }
  } else {
    console.error(`variante inconnue : ${variant}`);
    process.exit(2);
  }

  const m = measure(p.json);
  const checks = qualityChecks(p.json);
  const trace = parseTrace(logFile);
  const result = {
    variant, offerId, outDir,
    filesOk: existsSync(p.cv) && existsSync(p.lettre),
    cvPdf: existsSync(p.cv), lettre: existsSync(p.lettre), json: existsSync(p.json),
    measure: m,
    checks,
    trace,
    totalMs: steps.reduce((a, s) => a + s.durationMs, 0),
    steps,
  };
  writeFileSync(resolve(outDir, "result.json"), JSON.stringify(result, null, 2));
  console.log("@@FITBENCH " + JSON.stringify(result));
}

main().catch((e) => { console.error(e); process.exit(1); });
