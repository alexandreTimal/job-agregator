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
 * (valeurs possibles "stage" et "CDI"), `enabledSources`, `atsBoards`,
 * `salaryMin`, `locations` (villes) + `remoteOk` (télétravail),
 * `maxOfferAgeDays` (ancienneté max de mise en ligne, 0 = sans limite) et
 * `titleBlacklist` (mots bannis sur le titre seul). Les autres critères de
 * filtrage (exclude, defaultRadiusKm…) restent dans search.config.ts.
 */
import type { Settings } from "./shared/types";
import { getSettingsRaw, setSettingRaw, settingsEmpty } from "./store/sqlite";
import { config } from "../config/search.config";
import { sources } from "./sources/registry";

const KEY_TERMS = "terms";
const KEY_CONTRACT_TYPES = "contractTypes";
const KEY_ENABLED_SOURCES = "enabledSources";
const KEY_ATS_BOARDS = "atsBoards";
const KEY_SALARY_MIN = "salaryMin";
const KEY_LOCATIONS = "locations";
const KEY_REMOTE_OK = "remoteOk";
const KEY_MAX_OFFER_AGE_DAYS = "maxOfferAgeDays";
const KEY_TITLE_BLACKLIST = "titleBlacklist";
const KEY_CRON_ENABLED = "cronEnabled";
const KEY_CRON_TIMES = "cronTimes";

/** Défaut d'ancienneté max si la config statique n'en fournit pas (jours). */
const DEFAULT_MAX_OFFER_AGE_DAYS = 7;

/** Horaires planifiés par défaut (2×/jour, heure locale). */
const DEFAULT_CRON_TIMES = ["08:00", "20:00"];

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

/** Parse un entier ≥ 0 ; toute valeur invalide retombe sur `fallback`. */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function parseRecord(raw: string | undefined): Record<string, string[]> {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[k] = v.map((x) => String(x).trim()).filter((x) => x.length > 0);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Valeurs de seed initial dérivées de la config statique + du registry. */
function seedValues(): Settings {
  // `config.locations` mélange villes et le mot magique "remote" : on le scinde
  // pour le modèle piloté par l'UI (liste de villes + interrupteur `remoteOk`).
  const rawLocations = config.locations ?? [];
  const cities = rawLocations.filter((l) => l.trim().toLowerCase() !== "remote");
  const remoteOk = rawLocations.some((l) => l.trim().toLowerCase() === "remote");
  return {
    terms: config.terms,
    contractTypes: config.contractTypes ?? ["CDI"],
    enabledSources: sources.map((s) => s.name),
    atsBoards: {},
    salaryMin: config.salaryMin ?? 0,
    locations: cities,
    remoteOk,
    maxOfferAgeDays: config.maxOfferAgeDays ?? DEFAULT_MAX_OFFER_AGE_DAYS,
    titleBlacklist: config.titleBlacklist ?? [],
    cronEnabled: false,
    cronTimes: [...DEFAULT_CRON_TIMES],
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
    atsBoards: parseRecord(raw[KEY_ATS_BOARDS]),
    salaryMin: parseNonNegativeInt(raw[KEY_SALARY_MIN], seed.salaryMin),
    locations: parseList(raw[KEY_LOCATIONS], seed.locations),
    // Booléen absent → on retombe sur le seed (≠ cronEnabled qui défaut à false).
    remoteOk: raw[KEY_REMOTE_OK] === undefined ? seed.remoteOk : raw[KEY_REMOTE_OK] === "true",
    maxOfferAgeDays: parseNonNegativeInt(raw[KEY_MAX_OFFER_AGE_DAYS], seed.maxOfferAgeDays),
    titleBlacklist: parseList(raw[KEY_TITLE_BLACKLIST], seed.titleBlacklist),
    cronEnabled: raw[KEY_CRON_ENABLED] === "true",
    cronTimes: parseList(raw[KEY_CRON_TIMES], seed.cronTimes),
  };
}

/** Écrit la configuration effective (remplace les valeurs des trois champs). */
export function setSettings(settings: Settings): void {
  setSettingRaw(KEY_TERMS, JSON.stringify(settings.terms));
  setSettingRaw(KEY_CONTRACT_TYPES, JSON.stringify(settings.contractTypes));
  setSettingRaw(KEY_ENABLED_SOURCES, JSON.stringify(settings.enabledSources));
  setSettingRaw(KEY_ATS_BOARDS, JSON.stringify(settings.atsBoards));
  setSettingRaw(KEY_SALARY_MIN, String(settings.salaryMin));
  setSettingRaw(KEY_LOCATIONS, JSON.stringify(settings.locations));
  setSettingRaw(KEY_REMOTE_OK, String(settings.remoteOk));
  setSettingRaw(KEY_MAX_OFFER_AGE_DAYS, String(settings.maxOfferAgeDays));
  setSettingRaw(KEY_TITLE_BLACKLIST, JSON.stringify(settings.titleBlacklist));
  setSettingRaw(KEY_CRON_ENABLED, String(settings.cronEnabled));
  setSettingRaw(KEY_CRON_TIMES, JSON.stringify(settings.cronTimes));
}
