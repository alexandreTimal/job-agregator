/**
 * Orchestrateur de l'agrégateur.
 *
 * Flux : settings (sqlite) → [par terme × par source activée] fetch
 *        → dédup (sqlite) → filtre déterministe → score → tout reste en base
 *        (lisible par l'UI). Plus de push Notion.
 *
 * Lançable en CLI (`npm run fetch`) ou spawné en sous-process par le serveur
 * web. Émet des lignes JSON de progression sur stdout (préfixe `@@RUN `) que le
 * serveur relaie en SSE. Écrit une ligne dans la table `runs` à la fin.
 *
 * Usage :
 *   npm run fetch          # run réel
 *   npm run fetch:dry      # dry-run (ne persiste RIEN : ni offres, ni ligne runs)
 */
import { config } from "../config/search.config";
import type { SearchConfig } from "../config/search.config";
import type { SearchFilters } from "./lib/source-interface";
import { getEnabledSources } from "./sources/registry";
import { computeHash, normalizeText } from "./lib/normalize";
import { passesFilters, scoreOffer } from "./filter";
import { initDb, offerExists, insertOffer, insertRun, closeDb } from "./store/sqlite";
import { getSettings } from "./settings";
import { createLogger, logFilePath } from "./lib/logger";
import type { RunEvent } from "./shared/types";
import type { ScoredOffer } from "./lib/types";

const logger = createLogger("ORCHESTRATOR");

/** Émet un événement de progression sur stdout, relayé en SSE par le serveur. */
function emit(event: RunEvent): void {
  process.stdout.write(`@@RUN ${JSON.stringify(event)}\n`);
}

function buildFilters(term: string, contractTypes: string[]): SearchFilters {
  const cityLocations = (config.locations ?? [])
    .filter((l) => normalizeText(l) !== "remote")
    .map((label) => ({ label, radius: config.defaultRadiusKm ?? null }));

  return {
    keyword: term,
    locations: cityLocations.length ? cityLocations : undefined,
    contractTypes: contractTypes.length ? contractTypes : undefined,
    remotePreference: config.remote ?? "any",
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = Date.now();

  initDb();

  // Config EFFECTIVE pilotée par l'UI (table settings).
  const settings = getSettings();
  const activeSources = getEnabledSources(settings.enabledSources);

  // Critères de filtrage : config statique + contractTypes pilotés par l'UI.
  const effectiveConfig: SearchConfig = {
    ...config,
    terms: settings.terms,
    contractTypes: settings.contractTypes,
  };

  logger.info("Démarrage", {
    terms: settings.terms,
    sources: activeSources.map((s) => s.name),
    contractTypes: settings.contractTypes,
    dryRun,
    journal: logFilePath(),
  });

  const candidates = new Map<string, ScoredOffer>();
  const perSource: Record<string, number> = {};
  let found = 0;
  let newCount = 0;
  let duplicates = 0;

  for (const term of settings.terms) {
    const filters = buildFilters(term, settings.contractTypes);

    for (const source of activeSources) {
      // Les sources capturent leurs propres erreurs (best-effort) et renvoient [].
      const offers = await source.fetch({
        filters,
        maxPages: config.maxPagesPerSource ?? 3,
      });

      found += offers.length;
      perSource[source.name] = (perSource[source.name] ?? 0) + offers.length;
      emit({ type: "progress", term, source: source.name, found: offers.length });

      for (const offer of offers) {
        const hash = computeHash(offer);

        // Comptage explicite new vs duplicates (fini l'INSERT OR IGNORE muet).
        if (candidates.has(hash) || offerExists(hash)) {
          duplicates++;
          continue;
        }

        // Le filtre déterministe gouverne ce qui est persisté : une offre qui
        // échoue n'entre pas en base et ne sera donc jamais exposée à l'UI.
        const verdict = passesFilters(offer, effectiveConfig);
        if (!verdict.passed) continue;

        newCount++;

        // On calcule le score AVANT l'insertion pour le persister réellement
        // (le tri GET /api/offers?sort=score s'appuie dessus).
        const { score, priority } = scoreOffer(offer, effectiveConfig);
        candidates.set(hash, { ...offer, hash, score, priority });

        // En dry-run, on ne persiste rien (ni offres, ni ligne runs).
        if (dryRun) continue;

        insertOffer({
          hash,
          title: offer.title,
          company: offer.company,
          location: offer.location,
          url: offer.urlSource,
          source: offer.sourceName,
          score,
          publishedAt: offer.publishedAt ? offer.publishedAt.toISOString() : null,
        });
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info("Résumé", { found, new: newCount, duplicates, retenues: candidates.size });

  if (!dryRun) {
    insertRun({ durationMs, found, new: newCount, duplicates, perSource });
  }

  emit({ type: "done", message: "run terminé" });
  closeDb();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Run échoué", { error: message });
  emit({ type: "error", message });
  closeDb();
  process.exit(1);
});
