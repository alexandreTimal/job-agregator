/**
 * Agrège tous les result.json d'un dossier de runs en un tableau comparatif Markdown.
 * Usage : tsx aggregate.ts <dir1> [<dir2> ...]   (dossiers contenant des result.json)
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

function findResults(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = resolve(root, name);
    if (statSync(p).isDirectory()) {
      const r = resolve(p, "result.json");
      if (existsSync(r)) out.push(r);
      else out.push(...findResults(p));
    }
  }
  return out;
}

const argv = process.argv.slice(2);
let offerFilter: number | null = null;
const roots: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--offer") { offerFilter = Number(argv[++i]); continue; }
  roots.push(argv[i]);
}
if (roots.length === 0) { console.error("usage: tsx aggregate.ts [--offer N] <dir> [dir...]"); process.exit(2); }

const rows: any[] = [];
for (const root of roots) for (const f of findResults(root)) {
  try {
    const r = JSON.parse(readFileSync(f, "utf8"));
    if (offerFilter !== null && r.offerId !== offerFilter) continue;
    rows.push(r);
  } catch { /* ignore */ }
}
rows.sort((a, b) => (a.offerId - b.offerId) || String(a.variant).localeCompare(b.variant));

const yn = (b: any) => (b === true ? "✓" : b === false ? "✗" : "?");
console.log("| offre | variante | fit | fill% | header | files | en-têtes émis | agg entrée | ordre | nbExp | sous-agent | passes measure | min |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const m = r.measure;
  const t = r.trace ?? {};
  console.log(
    `| ${r.offerId} | ${r.variant} | ${m ? m.status : "NULL"} | ${m ? m.fill : "-"} | ${m ? yn(m.header_fits) : "-"} | ${yn(r.filesOk)} | ${yn(r.checks.headersEmitted)} | ${yn(r.checks.agregatorEntry)} | ${yn(r.checks.orderOk)} | ${r.checks.nbExperiences} | ${t.agentToolUses ?? "-"} | ${t.measurePasses ?? "-"} | ${(r.totalMs / 60000).toFixed(1)} |`,
  );
}

// Synthèse par variante : taux de fit OK + taux de fichiers complets.
console.log("\n### Synthèse par variante\n");
console.log("| variante | runs | fit ok | files ok | fill moyen | déborde (overflow) |");
console.log("|---|---|---|---|---|---|");
const byVar = new Map<string, any[]>();
for (const r of rows) { const k = r.variant; if (!byVar.has(k)) byVar.set(k, []); byVar.get(k)!.push(r); }
for (const [v, rs] of byVar) {
  const n = rs.length;
  const fitOk = rs.filter((r) => r.measure && r.measure.status === "ok" && r.measure.header_fits).length;
  const filesOk = rs.filter((r) => r.filesOk).length;
  const fills = rs.filter((r) => r.measure).map((r) => r.measure.fill);
  const avg = fills.length ? (fills.reduce((a: number, b: number) => a + b, 0) / fills.length).toFixed(1) : "-";
  const over = rs.filter((r) => r.measure && r.measure.status === "overflow").length;
  console.log(`| ${v} | ${n} | ${fitOk}/${n} | ${filesOk}/${n} | ${avg} | ${over} |`);
}
