/**
 * Configuration EFFECTIVE de l'agrégateur, stockée dans la table sqlite
 * `settings` (clé/valeur) et pilotée par l'UI.
 *
 * ## Profils de recherche
 *
 * Les 9 critères de recherche/filtrage (`terms`, `contractTypes`,
 * `enabledSources`, `atsBoards`, `salaryMin`, `locations`, `remoteOk`,
 * `maxOfferAgeDays`, `titleBlacklist`) vivent désormais dans des **profils
 * nommés** (clé `searchProfiles`, JSON). Un seul profil est **actif** (clé
 * `activeProfileId`) ; chaque run utilise les critères du profil actif. Seuls
 * `cronEnabled`/`cronTimes` restent **globaux** (la planification est système,
 * pas un angle de recherche) et continuent de vivre dans leurs propres clés.
 *
 * `getSettings()` fusionne « cron global + critères du profil actif » et rend
 * TOUJOURS la même forme `Settings` plate : l'orchestrateur et le filtre restent
 * intacts. `setSettings()` écrit les critères dans le profil actif et le cron
 * dans les clés globales.
 *
 * ## Seed & migration
 *
 * Au premier démarrage (table vide), la table est SEEDÉE depuis
 * `config/search.config.ts` + le registry : un profil « Par défaut » est créé.
 * Sur une base PRÉ-profils (clés plates `terms`/… présentes mais pas de profils),
 * `ensureProfiles()` migre paresseusement ces critères dans un profil « Par
 * défaut » sans rien perdre. Les anciennes clés plates deviennent vestigiales.
 */
import type {
  ProfileCriteria,
  SearchProfile,
  SearchProfileMeta,
  ProfilesState,
  Settings,
} from "./shared/types";
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

/** Clés du modèle profils. */
const KEY_SEARCH_PROFILES = "searchProfiles";
const KEY_ACTIVE_PROFILE_ID = "activeProfileId";
/** Compteur monotone d'ids de profil (jamais décrémenté → ids jamais ré-affectés). */
const KEY_PROFILE_SEQ = "profileSeq";

/** Identité du profil créé au seed / à la migration. */
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Par défaut";

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
    return sanitizeRecord(parsed);
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Sanitizers au niveau VALEUR (pour les critères déjà parsés depuis   */
/* le JSON des profils, par opposition aux clés plates string).        */
/* ------------------------------------------------------------------ */

function sanitizeStringList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.map((x) => String(x));
}

function sanitizeNonNegInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}

function sanitizeBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function sanitizeRecord(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      out[k] = val.map((x) => String(x).trim()).filter((x) => x.length > 0);
    }
  }
  return out;
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

/** Extrait les 9 critères d'un `Settings` (retire le cron global). */
function toCriteria(s: Settings): ProfileCriteria {
  const { cronEnabled: _ce, cronTimes: _ct, ...criteria } = s;
  return criteria;
}

/** Extrait les 9 critères d'un profil (retire `id`/`name`). */
function profileCriteria(p: SearchProfile): ProfileCriteria {
  const { id: _id, name: _name, ...criteria } = p;
  return criteria;
}

/** Lit les critères depuis les clés PLATES (seed/migration pré-profils). */
function criteriaFromFlatKeys(raw: Record<string, string>): ProfileCriteria {
  const seed = seedValues();
  return {
    terms: parseList(raw[KEY_TERMS], seed.terms),
    contractTypes: parseList(raw[KEY_CONTRACT_TYPES], seed.contractTypes),
    enabledSources: parseList(raw[KEY_ENABLED_SOURCES], seed.enabledSources),
    atsBoards: parseRecord(raw[KEY_ATS_BOARDS]),
    salaryMin: parseNonNegativeInt(raw[KEY_SALARY_MIN], seed.salaryMin),
    locations: parseList(raw[KEY_LOCATIONS], seed.locations),
    remoteOk: raw[KEY_REMOTE_OK] === undefined ? seed.remoteOk : raw[KEY_REMOTE_OK] === "true",
    maxOfferAgeDays: parseNonNegativeInt(raw[KEY_MAX_OFFER_AGE_DAYS], seed.maxOfferAgeDays),
    titleBlacklist: parseList(raw[KEY_TITLE_BLACKLIST], seed.titleBlacklist),
  };
}

/** Nettoie les critères issus d'une entrée JSON de profil (valeurs parsées). */
function sanitizeCriteria(v: unknown): ProfileCriteria {
  const seed = seedValues();
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    terms: sanitizeStringList(o.terms, seed.terms),
    contractTypes: sanitizeStringList(o.contractTypes, seed.contractTypes),
    enabledSources: sanitizeStringList(o.enabledSources, seed.enabledSources),
    atsBoards: sanitizeRecord(o.atsBoards),
    salaryMin: sanitizeNonNegInt(o.salaryMin, seed.salaryMin),
    locations: sanitizeStringList(o.locations, seed.locations),
    remoteOk: sanitizeBool(o.remoteOk, seed.remoteOk),
    maxOfferAgeDays: sanitizeNonNegInt(o.maxOfferAgeDays, seed.maxOfferAgeDays),
    titleBlacklist: sanitizeStringList(o.titleBlacklist, seed.titleBlacklist),
  };
}

/* ------------------------------------------------------------------ */
/* Profils : lecture / persistance / migration                         */
/* ------------------------------------------------------------------ */

interface ProfilesData {
  profiles: SearchProfile[];
  activeId: string;
}

/** Parse les profils depuis le raw ; `null` si la clé est absente/illisible. */
function readProfiles(raw: Record<string, string>): ProfilesData | null {
  const rawList = raw[KEY_SEARCH_PROFILES];
  // SEULE l'absence/illisibilité de la LISTE déclenche la migration. Un
  // `activeProfileId` manquant (ex. écriture interrompue entre les deux clés) ne
  // doit JAMAIS faire jeter une liste de profils valide : on retombe sur le 1er.
  if (rawList === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawList);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const profiles: SearchProfile[] = [];
  const seenIds = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0 || seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    const name =
      typeof e.name === "string" && e.name.trim().length > 0 ? e.name.trim() : e.id;
    profiles.push({ id: e.id, name, ...sanitizeCriteria(e) });
  }
  const [first] = profiles;
  if (first === undefined) return null;
  // `activeId` doit pointer un profil existant ; sinon retombe sur le premier.
  const rawActive = raw[KEY_ACTIVE_PROFILE_ID];
  const activeId =
    rawActive !== undefined && profiles.some((p) => p.id === rawActive) ? rawActive : first.id;
  return { profiles, activeId };
}

/** Écrit la liste des profils + l'id actif en base. */
function persistProfiles(data: ProfilesData): void {
  setSettingRaw(KEY_SEARCH_PROFILES, JSON.stringify(data.profiles));
  setSettingRaw(KEY_ACTIVE_PROFILE_ID, data.activeId);
}

/**
 * Garantit qu'au moins un profil existe et que l'id actif est valide. Migre
 * paresseusement une base pré-profils (clés plates) vers un profil « Par défaut ».
 */
function ensureProfiles(): ProfilesData {
  seedSettingsIfEmpty();
  const raw = getSettingsRaw();
  const existing = readProfiles(raw);
  if (existing) {
    // Si `activeId` a été corrigé (pointait un profil disparu), persiste le fix.
    if (raw[KEY_ACTIVE_PROFILE_ID] !== existing.activeId) {
      setSettingRaw(KEY_ACTIVE_PROFILE_ID, existing.activeId);
    }
    return existing;
  }
  // Migration depuis les clés plates (base antérieure aux profils).
  const data: ProfilesData = {
    profiles: [
      { id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, ...criteriaFromFlatKeys(raw) },
    ],
    activeId: DEFAULT_PROFILE_ID,
  };
  persistProfiles(data);
  return data;
}

/** Profil actif d'un `ProfilesData` — garanti non vide par `ensureProfiles()`. */
function activeProfile(data: ProfilesData): SearchProfile {
  const found = data.profiles.find((p) => p.id === data.activeId);
  if (found) return found;
  const [first] = data.profiles;
  // `ensureProfiles()` garantit ≥ 1 profil ; ce repli ne devrait jamais manquer.
  if (first === undefined) throw new Error("aucun profil de recherche disponible");
  return first;
}

/** Plus grand numéro `p<n>` parmi des profils (0 si aucun). */
function maxProfileNumber(profiles: SearchProfile[]): number {
  let max = 0;
  for (const p of profiles) {
    const m = /^p(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Codes d'erreur métier des opérations sur les profils (mappés en HTTP). */
export type ProfileErrorCode = "INVALID_NAME" | "NOT_FOUND" | "LAST_PROFILE";

export class ProfileError extends Error {
  constructor(public readonly code: ProfileErrorCode) {
    super(code);
    this.name = "ProfileError";
  }
}

/* ------------------------------------------------------------------ */
/* API publique                                                        */
/* ------------------------------------------------------------------ */

/** Seede la table `settings` (cron global + profil par défaut) si elle est vide. */
export function seedSettingsIfEmpty(): void {
  if (!settingsEmpty()) return;
  const seed = seedValues();
  setSettingRaw(KEY_CRON_ENABLED, String(seed.cronEnabled));
  setSettingRaw(KEY_CRON_TIMES, JSON.stringify(seed.cronTimes));
  persistProfiles({
    profiles: [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, ...toCriteria(seed) }],
    activeId: DEFAULT_PROFILE_ID,
  });
}

/** Lit la configuration effective = cron global + critères du profil actif. */
export function getSettings(): Settings {
  const data = ensureProfiles();
  const active = activeProfile(data);
  const raw = getSettingsRaw();
  return {
    ...profileCriteria(active),
    cronEnabled: raw[KEY_CRON_ENABLED] === "true",
    cronTimes: parseList(raw[KEY_CRON_TIMES], DEFAULT_CRON_TIMES),
  };
}

/**
 * Écrit la configuration effective : le cron va dans les clés globales, les 9
 * critères dans le PROFIL ACTIF (les autres profils sont intacts).
 */
export function setSettings(settings: Settings): void {
  setSettingRaw(KEY_CRON_ENABLED, String(settings.cronEnabled));
  setSettingRaw(KEY_CRON_TIMES, JSON.stringify(settings.cronTimes));
  const { profiles, activeId } = ensureProfiles();
  const criteria = toCriteria(settings);
  const next = profiles.map((p) => (p.id === activeId ? { ...p, ...criteria } : p));
  persistProfiles({ profiles: next, activeId });
}

/** Liste les profils (vue allégée) + l'id actif. */
export function listProfiles(): ProfilesState {
  const { profiles, activeId } = ensureProfiles();
  return {
    activeProfileId: activeId,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
  };
}

/**
 * Crée un profil dont les critères CLONENT le profil actif (point de départ
 * pratique). Ne l'active PAS. Lève `ProfileError("INVALID_NAME")` si nom vide.
 */
export function createProfile(name: string): SearchProfileMeta {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new ProfileError("INVALID_NAME");
  const data = ensureProfiles();
  const active = activeProfile(data);
  // Id monotone : max(compteur persisté, plus haut numéro existant) + 1. Le
  // compteur n'est jamais décrémenté → un id supprimé n'est jamais ré-affecté,
  // même si on supprime le profil au plus haut numéro.
  const raw = getSettingsRaw();
  const prev = Math.max(
    parseNonNegativeInt(raw[KEY_PROFILE_SEQ], 0),
    maxProfileNumber(data.profiles),
  );
  const seq = prev + 1;
  const id = `p${seq}`;
  setSettingRaw(KEY_PROFILE_SEQ, String(seq));
  const profile: SearchProfile = { id, name: trimmed, ...profileCriteria(active) };
  persistProfiles({ profiles: [...data.profiles, profile], activeId: data.activeId });
  return { id, name: trimmed };
}

/** Renomme un profil. Lève NOT_FOUND / INVALID_NAME. */
export function renameProfile(id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new ProfileError("INVALID_NAME");
  const { profiles, activeId } = ensureProfiles();
  if (!profiles.some((p) => p.id === id)) throw new ProfileError("NOT_FOUND");
  const next = profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  persistProfiles({ profiles: next, activeId });
}

/** Active un profil existant. Lève NOT_FOUND. */
export function activateProfile(id: string): void {
  const { profiles } = ensureProfiles();
  if (!profiles.some((p) => p.id === id)) throw new ProfileError("NOT_FOUND");
  persistProfiles({ profiles, activeId: id });
}

/**
 * Supprime un profil. Lève NOT_FOUND, ou LAST_PROFILE s'il ne resterait aucun
 * profil. Si on supprime l'actif, un autre profil (le premier restant) le devient.
 */
export function deleteProfile(id: string): void {
  const { profiles, activeId } = ensureProfiles();
  if (!profiles.some((p) => p.id === id)) throw new ProfileError("NOT_FOUND");
  if (profiles.length <= 1) throw new ProfileError("LAST_PROFILE");
  const next = profiles.filter((p) => p.id !== id);
  // `next` est non vide (length était > 1) ; le premier restant devient actif.
  const nextActive = id === activeId ? (next[0] as SearchProfile).id : activeId;
  persistProfiles({ profiles: next, activeId: nextActive });
}
