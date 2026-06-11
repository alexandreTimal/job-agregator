/**
 * Orchestrateur de l'agrégateur.
 *
 * Flux : config.terms → [par terme × par source] fetch → dédup (sqlite)
 *        → filtre déterministe → score → export Notion.
 *
 * Usage :
 *   npm run fetch          # run réel (pousse dans Notion)
 *   npm run fetch:dry      # dry-run (log seulement, ne crée rien dans Notion)
 */
import { config } from "../config/search.config";
import type { SearchFilters } from "./lib/source-interface";
import { sources } from "./sources/registry";
import { computeHash, normalizeText } from "./lib/normalize";
import { passesFilters, scoreOffer } from "./filter";
import { initDb, isNotifiedNotion, insertOffer, closeDb } from "./store/sqlite";
import { pushToNotion } from "./notion";
import { createLogger } from "./lib/logger";
import type { ScoredOffer } from "./lib/types";

const logger = createLogger("ORCHESTRATOR");

function buildFilters(term: string): SearchFilters {
  const cityLocations = (config.locations ?? [])
    .filter((l) => normalizeText(l) !== "remote")
    .map((label) => ({ label, radius: config.defaultRadiusKm ?? null }));

  return {
    keyword: term,
    locations: cityLocations.length ? cityLocations : undefined,
    contractTypes: config.contractTypes,
    remotePreference: config.remote ?? "any",
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  logger.info("Démarrage", { terms: config.terms, sources: sources.map((s) => s.name), dryRun });

  initDb();

  const candidates = new Map<string, ScoredOffer>();
  let totalFetched = 0;
  let totalFiltered = 0;

  for (const term of config.terms) {
    const filters = buildFilters(term);

    for (const source of sources) {
      logger.info("Fetch", { term, source: source.name });

      // Les sources capturent leurs propres erreurs (best-effort) et renvoient [].
      const offers = await source.fetch({
        filters,
        maxPages: config.maxPagesPerSource ?? 3,
      });
      totalFetched += offers.length;

      for (const offer of offers) {
        const hash = computeHash(offer);

        if (candidates.has(hash)) continue; // déjà retenue ce run
        if (isNotifiedNotion(hash)) continue; // déjà dans Notion

        // Trace l'offre comme vue (dédup persistant), même si filtrée ensuite.
        insertOffer({
          hash,
          title: offer.title,
          company: offer.company,
          url: offer.urlSource,
          source: offer.sourceName,
          score: 0,
        });

        const verdict = passesFilters(offer, config);
        if (!verdict.passed) {
          totalFiltered++;
          continue;
        }

        const { score, priority } = scoreOffer(offer, config);
        candidates.set(hash, { ...offer, hash, score, priority });
      }
    }
  }

  const toPush = [...candidates.values()].sort((a, b) => b.score - a.score);
  logger.info("Résumé", {
    fetched: totalFetched,
    filtered: totalFiltered,
    retenues: toPush.length,
  });

  await pushToNotion(toPush, { dryRun });
  closeDb();
  logger.info("Terminé");
}

main().catch((err) => {
  logger.error("Run échoué", { error: err instanceof Error ? err.message : String(err) });
  closeDb();
  process.exit(1);
});
