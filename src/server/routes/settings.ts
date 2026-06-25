/**
 * Routes de configuration (cf. docs/api-contract.md).
 *
 *   GET /api/settings → Settings
 *   PUT /api/settings  body Settings → {ok:true}
 *
 * La config effective vit dans la table sqlite `settings` ; l'accès est
 * centralisé dans `src/settings.ts` (getSettings / setSettings), seedé une
 * première fois depuis config/search.config.ts.
 */
import type { FastifyInstance } from "fastify";
import type { Settings } from "../../shared/types";
import { getSettings, setSettings } from "../../settings";
import { isValidTime } from "../../lib/cron-schedule";
import { getScheduler } from "../scheduler";

/** Valeurs de `contractTypes` acceptées par le contrat. */
const CONTRACT_TYPES = new Set(["stage", "CDI"]);

/** Vrai si `value` est un tableau de chaînes (éventuellement vide). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Vrai si `value` est un Record<string, string[]> (ou absent → {} en aval). */
function parseAtsBoards(value: unknown): Record<string, string[]> | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isStringArray(v)) return null;
    const seen = new Set<string>();
    out[k] = v.map((s) => s.trim()).filter((s) => s.length > 0 && !seen.has(s) && seen.add(s));
  }
  return out;
}

/**
 * Valide le corps de PUT /api/settings et renvoie un objet `Settings` propre,
 * ou null si le corps est mal formé. On dédoublonne et on nettoie les chaînes.
 */
function parseSettingsBody(body: unknown): Settings | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;

  if (!isStringArray(candidate.terms)) return null;
  if (!isStringArray(candidate.contractTypes)) return null;
  if (!isStringArray(candidate.enabledSources)) return null;

  const atsBoards = parseAtsBoards(candidate.atsBoards);
  if (atsBoards === null) return null;

  // contractTypes : uniquement "stage" et "CDI".
  if (!candidate.contractTypes.every((t) => CONTRACT_TYPES.has(t))) return null;

  // salaryMin : entier ≥ 0 (0 = sans minimum).
  const salaryMin = candidate.salaryMin;
  if (typeof salaryMin !== "number" || !Number.isInteger(salaryMin) || salaryMin < 0) {
    return null;
  }

  // locations : tableau de villes ; remoteOk : booléen (télétravail accepté).
  if (!isStringArray(candidate.locations)) return null;
  if (typeof candidate.remoteOk !== "boolean") return null;

  // maxOfferAgeDays : entier ≥ 0 (0 = sans limite).
  const maxOfferAgeDays = candidate.maxOfferAgeDays;
  if (
    typeof maxOfferAgeDays !== "number" ||
    !Number.isInteger(maxOfferAgeDays) ||
    maxOfferAgeDays < 0
  ) {
    return null;
  }

  // titleBlacklist : tableau de chaînes (mots bannis sur le titre). Lenient comme
  // `atsBoards` : un corps legacy sans ce champ vaut liste vide plutôt que 400.
  const titleBlacklist = candidate.titleBlacklist === undefined ? [] : candidate.titleBlacklist;
  if (!isStringArray(titleBlacklist)) return null;

  // cronEnabled : booléen ; cronTimes : tableau d'horaires "HH:MM" valides.
  if (typeof candidate.cronEnabled !== "boolean") return null;
  if (!isStringArray(candidate.cronTimes)) return null;
  if (!candidate.cronTimes.every((t) => isValidTime(t))) return null;

  const clean = (list: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const v = raw.trim();
      if (v.length === 0 || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  return {
    terms: clean(candidate.terms),
    contractTypes: clean(candidate.contractTypes),
    enabledSources: clean(candidate.enabledSources),
    atsBoards,
    salaryMin,
    locations: clean(candidate.locations),
    remoteOk: candidate.remoteOk,
    maxOfferAgeDays,
    titleBlacklist: clean(titleBlacklist),
    cronEnabled: candidate.cronEnabled,
    cronTimes: clean(candidate.cronTimes),
  };
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => getSettings());

  app.put<{ Body: unknown }>("/api/settings", async (request, reply) => {
    const settings = parseSettingsBody(request.body);
    if (settings === null) {
      return reply.code(400).send({ ok: false, error: "configuration mal formée" });
    }
    setSettings(settings);
    // Réarme le scheduler sur les nouveaux horaires sans redémarrer le serveur.
    getScheduler().reload();
    return { ok: true };
  });
}
