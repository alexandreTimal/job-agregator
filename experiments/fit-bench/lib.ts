/**
 * Banc d'essai « fit » — helpers partagés (hors prod, ne touche pas candidature.ts).
 *
 * But : comparer 3 architectures d'orchestration de la génération de CV sur leur
 * FIABILITÉ à produire un CV qui tient sur 1 page (94–100 %), sans garde-fou algo.
 * L'oracle de comparaison est `generate_cv.py --measure` (déterministe, hors-ligne).
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
export const VENV_PY = resolve(PROJECT_ROOT, ".venv/bin/python");
export const GENERATE_CV = resolve(PROJECT_ROOT, "candidature-toolkit/skills/cv-render/generate_cv.py");
export const DB_PATH = process.env.JOB_AGREGATOR_DB ?? resolve(PROJECT_ROOT, "data/job-agregator.db");
export const MODEL = process.env.FITBENCH_MODEL ?? "sonnet";
export const TIMEOUT_MS = Math.max(60_000, Number(process.env.FITBENCH_TIMEOUT_MS ?? 900_000));

function resolveClaudeBin(): string {
  if (process.env.CANDIDATURE_CLAUDE_BIN) return process.env.CANDIDATURE_CLAUDE_BIN;
  const local = resolve(homedir(), ".local/bin/claude");
  return existsSync(local) ? local : "claude";
}
export const CLAUDE_BIN = resolveClaudeBin();

/** Config MCP vide (system prompt léger : aucun serveur MCP chargé). */
export const EMPTY_MCP_CONFIG = resolve(PROJECT_ROOT, "data/fit-bench/.mcp-empty.json");

/** Home minimal hors-repo : seulement les 3 skills candidature + petit CLAUDE.md. */
export const AGENT_HOME = resolve(homedir(), ".cache/job-agregator/candidature-home");
const CANDIDATURE_SKILLS = ["cv-tailoring", "cv-render", "lettre-motivation"];

/** (Re)construit l'env dépouillé de l'agent : MCP vide + home minimal. Idempotent. */
export function ensureEnv(): void {
  mkdirSync(resolve(PROJECT_ROOT, "data/fit-bench"), { recursive: true });
  writeFileSync(EMPTY_MCP_CONFIG, '{"mcpServers":{}}');
  const skillsDir = resolve(AGENT_HOME, ".claude/skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const name of CANDIDATURE_SKILLS) {
    const dst = resolve(skillsDir, name);
    // Idempotent + sûr en concurrence : si le symlink existe déjà (autre process du
    // banc lancé en parallèle), on le laisse — pas de rm/symlink racé (qui levait EEXIST).
    if (existsSync(dst)) continue;
    try { symlinkSync(resolve(PROJECT_ROOT, "candidature-toolkit/skills", name), dst, "dir"); }
    catch (e: any) { if (e?.code !== "EEXIST") throw e; }
  }
  writeFileSync(
    resolve(AGENT_HOME, "CLAUDE.md"),
    "# Home de l'agent candidature\n\nSeuls les skills cv-tailoring, cv-render, lettre-motivation sont disponibles ici.\n",
  );
}

export interface Offer { id: number; title: string; company: string | null; location: string | null; url: string; }

export function getOffer(id: number): Offer {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const r = db.prepare("SELECT id,title,company,location,url FROM seen_offers WHERE id=?").get(id) as Offer | undefined;
    if (!r) throw new Error(`offre ${id} introuvable`);
    return r;
  } finally {
    db.close();
  }
}

export interface SpawnResult { code: number | null; durationMs: number; stderrTail: string; }

/**
 * Lance un `claude -p` headless dans l'env dépouillé (MCP vide, home minimal, Sonnet).
 * stdout+stderr journalisés dans logFile. `allowedTools` surchargeable (variante A
 * ajoute "Agent"). Retour : code de sortie + durée + fin de stderr.
 */
export function spawnClaude(opts: {
  prompt: string;
  allowedTools: string[];
  logFile: string;
  startMs: number;
}): Promise<SpawnResult> {
  const { prompt, allowedTools, logFile, startMs } = opts;
  return new Promise((resolveP) => {
    const log = createWriteStream(logFile, { flags: "a" });
    const child = spawn(
      CLAUDE_BIN,
      [
        "-p", prompt,
        "--allowedTools", ...allowedTools,
        "--permission-mode", "acceptEdits",
        "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG,
        "--no-chrome",
        "--model", MODEL,
        "--setting-sources", "project",
        "--add-dir", PROJECT_ROOT,
        // stream-json + verbose : le log capture les appels d'outils (tool_use), ce qui
        // permet de TRACER l'usage réel du sous-agent (variante A) et les passes --measure.
        "--output-format", "stream-json", "--verbose",
      ],
      { cwd: AGENT_HOME, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    let stderrTail = "";
    const t = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* mort */ } }, TIMEOUT_MS);
    if (typeof t.unref === "function") t.unref();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => log.write(c));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => { log.write(c); stderrTail = (stderrTail + c).slice(-1500); });
    const done = (code: number | null) => {
      clearTimeout(t);
      log.end();
      resolveP({ code, durationMs: Date.now() - startMs, stderrTail });
    };
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
}

export interface Measure { fits: boolean; header_fits: boolean; status: string; fill: number; overflow_lines: number; }

export interface Trace { agentToolUses: number; measurePasses: number; renderCalls: number; }

/**
 * Parse un log stream-json (JSONL d'événements) pour tracer le MÉCANISME :
 * - agentToolUses : nb d'appels à l'outil `Agent` (= sous-agent réellement spawné).
 * - measurePasses : nb de commandes Bash contenant `--measure` (passes de la boucle fit).
 * - renderCalls   : nb de rendus PDF (`--out`). Best-effort (null jamais : 0 si rien).
 */
export function parseTrace(logFile: string): Trace {
  const t: Trace = { agentToolUses: 0, measurePasses: 0, renderCalls: 0 };
  if (!existsSync(logFile)) return t;
  let lines: string[];
  try { lines = readFileSync(logFile, "utf8").split("\n"); } catch { return t; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev.message ?? ev;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      if (block.name === "Agent" || block.name === "Task") t.agentToolUses++;
      if (block.name === "Bash") {
        const cmd = String(block.input?.command ?? "");
        if (cmd.includes("--measure")) t.measurePasses++;
        if (cmd.includes("--out")) t.renderCalls++;
      }
    }
  }
  return t;
}

/** Oracle de fit déterministe : lit le rapport JSON de `generate_cv.py --measure`. */
export function measure(jsonPath: string): Measure | null {
  if (!existsSync(jsonPath)) return null;
  try {
    const out = execFileSync(VENV_PY, [GENERATE_CV, jsonPath, "--measure"], { encoding: "utf8" });
    const d = JSON.parse(out);
    return {
      fits: !!d.fits,
      header_fits: !!d.header_fits,
      status: String(d.status),
      fill: Math.round(d.fill_ratio * 1000) / 10,
      overflow_lines: Number(d.overflow_lines ?? 0),
    };
  } catch {
    return null;
  }
}
