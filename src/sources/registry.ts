import type { ScrapingSource } from "../lib/source-interface";
import { wttjSource } from "./wttj";
import { helloworkSource } from "./hellowork";

/**
 * Liste des sources actives du MVP. Ajouter une source = créer son fichier
 * (interface ScrapingSource) puis l'ajouter ici.
 *
 * Phase 1.5 (à porter depuis Job_watcher/src/sources) : indeed, linkedin-email,
 * google-alerts-rss, station-f, career-pages. France Travail (API) ajoutable
 * trivialement, même interface.
 */
export const sources: ScrapingSource[] = [wttjSource, helloworkSource];

/**
 * Filtre le registry par les noms de sources activées (cf. `enabledSources`
 * de la table `settings`, piloté par l'UI). L'ordre du registry est conservé.
 * Un nom inconnu est simplement ignoré (best-effort).
 */
export function getEnabledSources(names: string[]): ScrapingSource[] {
  const enabled = new Set(names);
  return sources.filter((s) => enabled.has(s.name));
}
