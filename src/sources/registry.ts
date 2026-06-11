import type { ScrapingSource } from "../lib/source-interface";
import { wttjSource } from "./wttj";
import { helloworkSource } from "./hellowork";
import { linkedinSource } from "./linkedin";
import { greenhouseSource } from "./ats/greenhouse";
import { leverSource } from "./ats/lever";

/**
 * Registry des sources. Ajouter une source = créer son fichier (interface
 * ScrapingSource) puis l'ajouter ici.
 *
 * - web : wttj, hellowork (scraping navigateur).
 * - ats : greenhouse, lever (API JSON ; boards éditables depuis l'UI via
 *   `settings.atsBoards`). Restent inertes tant qu'aucun board n'est configuré.
 *
 * À porter ensuite (best-effort) : indeed, station-f.
 */
export const sources: ScrapingSource[] = [
  wttjSource,
  helloworkSource,
  linkedinSource,
  greenhouseSource,
  leverSource,
];

/**
 * Filtre le registry par les noms de sources activées (cf. `enabledSources`
 * de la table `settings`, piloté par l'UI). L'ordre du registry est conservé.
 * Un nom inconnu est simplement ignoré (best-effort).
 */
export function getEnabledSources(names: string[]): ScrapingSource[] {
  const enabled = new Set(names);
  return sources.filter((s) => enabled.has(s.name));
}
