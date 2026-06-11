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

/** Valeurs de `contractTypes` acceptées par le contrat. */
const CONTRACT_TYPES = new Set(["stage", "CDI"]);

/** Vrai si `value` est un tableau de chaînes (éventuellement vide). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
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

  // contractTypes : uniquement "stage" et "CDI".
  if (!candidate.contractTypes.every((t) => CONTRACT_TYPES.has(t))) return null;

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
    return { ok: true };
  });
}
