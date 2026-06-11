/**
 * Configuration EFFECTIVE de l'agrégateur, stockée dans la table sqlite
 * `settings` (clé/valeur) et pilotée par l'UI.
 *
 * Flux : au premier démarrage, la table est SEEDÉE depuis
 * `config/search.config.ts` + le registry des sources. Ensuite, c'est
 * `settings` qui fait foi : l'orchestrateur lit `getSettings()` à chaque run,
 * et l'UI écrit via `setSettings()`.
 *
 * Seuls les champs pilotés par l'UI vivent ici : `terms`, `contractTypes`
 * (valeurs possibles "stage" et "CDI") et `enabledSources`. Les autres critères
 * de filtrage (exclude, salaryMin, locations…) restent dans search.config.ts.
 */
import type { Settings } from "./shared/types";
import { getSettingsRaw, setSettingRaw, settingsEmpty } from "./store/sqlite";
import { config } from "../config/search.config";
import { sources } from "./sources/registry";

const KEY_TERMS = "terms";
const KEY_CONTRACT_TYPES = "contractTypes";
const KEY_ENABLED_SOURCES = "enabledSources";

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    return fallback;
  } catch {
    return fallback;
  }
}

/** Valeurs de seed initial dérivées de la config statique + du registry. */
function seedValues(): Settings {
  return {
    terms: config.terms,
    contractTypes: config.contractTypes ?? ["CDI"],
    enabledSources: sources.map((s) => s.name),
  };
}

/** Seede la table `settings` depuis la config statique si elle est vide. */
export function seedSettingsIfEmpty(): void {
  if (!settingsEmpty()) return;
  setSettings(seedValues());
}

/** Lit la configuration effective (avec seed paresseux si table vide). */
export function getSettings(): Settings {
  seedSettingsIfEmpty();
  const raw = getSettingsRaw();
  const seed = seedValues();
  return {
    terms: parseList(raw[KEY_TERMS], seed.terms),
    contractTypes: parseList(raw[KEY_CONTRACT_TYPES], seed.contractTypes),
    enabledSources: parseList(raw[KEY_ENABLED_SOURCES], seed.enabledSources),
  };
}

/** Écrit la configuration effective (remplace les valeurs des trois champs). */
export function setSettings(settings: Settings): void {
  setSettingRaw(KEY_TERMS, JSON.stringify(settings.terms));
  setSettingRaw(KEY_CONTRACT_TYPES, JSON.stringify(settings.contractTypes));
  setSettingRaw(KEY_ENABLED_SOURCES, JSON.stringify(settings.enabledSources));
}
