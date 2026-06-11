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
import { fileURLToPath } from "node:url";
import { config } from "../config/search.config";
import type { SearchConfig } from "../config/search.config";
import type { ScrapingSource, SearchFilters } from "./lib/source-interface";
import { getEnabledSources } from "./sources/registry";
import { computeHash, normalizeText } from "./lib/normalize";
import { passesFilters, scoreOffer } from "./filter";
import { initDb, offerExists, insertOffer, insertRun, closeDb } from "./store/sqlite";
import { getSettings } from "./settings";
import { pLimit, withTimeout } from "./lib/concurrency";
import { createLogger, logFilePath } from "./lib/logger";
import type { RunEvent, Settings } from "./shared/types";
import type { ScoredOffer } from "./lib/types";

const logger = createLogger("ORCHESTRATOR");

/** Sources en parallèle (web = un seul navigateur/source, hôte jamais frappé 2× à la fois). */
const SOURCE_CONCURRENCY = 4;
/** Une source traite TOUS ses termes : timeout large. */
const SOURCE_TIMEOUT_MS = 240_000;

/** Émet un événement de progression sur stdout, relayé en SSE par le serveur. */
function emit(event: RunEvent): void {
  process.stdout.write(`@@RUN ${JSON.stringify(event)}\n`);
}

/**
 * Filtres communs à toutes les sources web (le keyword est injecté par terme).
 * `locations` = villes pilotées par l'UI ; chaque ville devient une recherche
 * distincte côté source (cf. `locationSlots`) puisqu'aucun jobboard n'accepte
 * plusieurs villes en une requête. Le rayon reste un défaut statique global
 * (`defaultRadiusKm`). Le « remote » n'entre PAS dans la recherche (géré en
 * post-filtre) : on filtre défensivement le mot magique s'il traîne.
 */
function buildBaseFilters(contractTypes: string[], locations: string[]): SearchFilters {
  const cityLocations = locations
    .filter((l) => normalizeText(l) !== "remote")
    .map((label) => ({ label, radius: config.defaultRadiusKm ?? null }));

  return {
    locations: cityLocations.length ? cityLocations : undefined,
    contractTypes: contractTypes.length ? contractTypes : undefined,
    remotePreference: config.remote ?? "any",
  };
}

/** Bilan d'un run, renvoyé par `runPipeline` (sans I/O d'init/fin). */
export interface RunSummary {
  found: number;
  newCount: number;
  duplicates: number;
  perSource: Record<string, number>;
  /** Nombre d'offres uniques retenues (= taille du Map de candidats). */
  retained: number;
}

/**
 * Cœur testable du pipeline : fetch concurrent (1 tâche/source) → dédup
 * inter-sources → filtre déterministe → score → persistance (hors dry-run).
 *
 * Aucune I/O d'init/fin : `initDb`/`insertRun`/`closeDb` restent dans `main()`.
 * Les helpers `offerExists`/`insertOffer` du store supposent la DB déjà ouverte.
 * La progression est émise via `emitEvent` (en CLI/serveur : `emit` → SSE).
 */
export async function runPipeline(
  activeSources: ScrapingSource[],
  settings: Settings,
  effectiveConfig: SearchConfig,
  dryRun: boolean,
  emitEvent: (event: RunEvent) => void,
): Promise<RunSummary> {
  const candidates = new Map<string, ScoredOffer>();
  const perSource: Record<string, number> = {};
  let found = 0;
  let newCount = 0;
  let duplicates = 0;

  const baseFilters = buildBaseFilters(settings.contractTypes, settings.locations);
  const limit = pLimit(SOURCE_CONCURRENCY);

  // Compteur d'avancement : sources terminées / total. Incrément sûr (JS
  // mono-thread : aucun entrelacement réel sur `sourcesDone++`).
  const totalSources = activeSources.length;
  let sourcesDone = 0;

  // Lancement : annonce le volume de travail dès le clic (avant tout fetch),
  // pour que l'UI montre immédiatement de l'activité plutôt qu'un statut figé.
  emitEvent({
    type: "progress",
    phase: "start",
    totalSources,
    totalTerms: settings.terms.length,
  });

  // Une tâche par source : la source boucle elle-même sur tous les termes.
  const tasks = activeSources.map((source) =>
    limit(async () => {
      const boards = settings.atsBoards?.[source.name] ?? [];
      const controller = new AbortController();
      // Démarrage de la source : visible dès qu'un slot pLimit se libère.
      emitEvent({ type: "progress", phase: "source-start", source: source.name });
      let offers: Awaited<ReturnType<typeof source.fetch>> = [];
      try {
        offers = await withTimeout(
          source.fetch({
            terms: settings.terms,
            filters: baseFilters,
            boards,
            maxPages: config.maxPagesPerSource ?? 3,
            signal: controller.signal,
            // Progression intra-source : relayée telle quelle vers l'UI. Permet
            // de bouger pendant qu'une source web boucle ses termes en silence.
            // `...info` d'abord : `phase`/`source` autoritatifs ne peuvent être écrasés.
            onProgress: (info) =>
              emitEvent({ type: "progress", ...info, phase: "source-progress", source: source.name }),
          }),
          SOURCE_TIMEOUT_MS,
        );
      } catch (err) {
        // Timeout/erreur : on signale la source abandonnée pour qu'elle ferme son
        // navigateur (sinon il resterait ouvert jusqu'à la résolution de sa propre
        // promesse — fuite de ressource + slot pLimit occupé). Best-effort.
        controller.abort();
        logger.warn("Source ignorée (échec ou timeout)", {
          source: source.name,
          error: err instanceof Error ? err.message : String(err),
        });
        offers = [];
      }
      perSource[source.name] = offers.length;
      // Fin de source : fait avancer le compteur global (même en échec :
      // best-effort, le run atteint toujours N/N puis `done`).
      sourcesDone++;
      emitEvent({
        type: "progress",
        phase: "source-done",
        source: source.name,
        found: offers.length,
        sourcesDone,
        totalSources,
      });
      return offers;
    }),
  );

  const offersBySource = await Promise.all(tasks);

  for (const offers of offersBySource) {
    found += offers.length;
    for (const offer of offers) {
      const hash = computeHash(offer);

      if (candidates.has(hash) || offerExists(hash)) {
        duplicates++;
        continue;
      }

      const verdict = passesFilters(offer, effectiveConfig);
      if (!verdict.passed) continue;

      newCount++;

      const { score, priority } = scoreOffer(offer, effectiveConfig);
      candidates.set(hash, { ...offer, hash, score, priority });

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

  return { found, newCount, duplicates, perSource, retained: candidates.size };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = Date.now();

  initDb();

  // Config EFFECTIVE pilotée par l'UI (table settings).
  const settings = getSettings();
  const activeSources = getEnabledSources(settings.enabledSources);

  // Critères de filtrage : config statique (exclude…) + champs pilotés par l'UI.
  // `locations` du filtre pur = villes + le mot magique "remote" (si `remoteOk`),
  // pour garder `filter.ts` inchangé (il connaît déjà ce token).
  const effectiveConfig: SearchConfig = {
    ...config,
    terms: settings.terms,
    contractTypes: settings.contractTypes,
    salaryMin: settings.salaryMin,
    locations: [...settings.locations, ...(settings.remoteOk ? ["remote"] : [])],
    maxOfferAgeDays: settings.maxOfferAgeDays,
  };

  logger.info("Démarrage", {
    terms: settings.terms,
    sources: activeSources.map((s) => s.name),
    contractTypes: settings.contractTypes,
    salaryMin: settings.salaryMin,
    locations: settings.locations,
    remoteOk: settings.remoteOk,
    dryRun,
    journal: logFilePath(),
  });

  const summary = await runPipeline(activeSources, settings, effectiveConfig, dryRun, emit);

  const durationMs = Date.now() - startedAt;
  logger.info("Résumé", {
    found: summary.found,
    new: summary.newCount,
    duplicates: summary.duplicates,
    retenues: summary.retained,
  });

  if (!dryRun) {
    insertRun({
      startedAt,
      durationMs,
      found: summary.found,
      new: summary.newCount,
      duplicates: summary.duplicates,
      perSource: summary.perSource,
    });
  }

  // Le terminal porte les compteurs : le serveur (scheduler) s'en sert pour la
  // notification bureau « N nouvelles offres », sans relire la base.
  emit({ type: "done", message: "run terminé", newOffers: summary.newCount, found: summary.found });
  closeDb();
}

// N'exécute `main()` QUE si ce fichier est l'entrée (CLI `npm run fetch`, ou
// spawn serveur). À l'import (tests), `runPipeline` est exporté sans effet de bord.
const isEntry = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Run échoué", { error: message });
    emit({ type: "error", message });
    closeDb();
    process.exit(1);
  });
}
