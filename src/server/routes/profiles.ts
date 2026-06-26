/**
 * Routes des profils de recherche (cf. docs/api-contract.md).
 *
 *   GET    /api/profiles            → ProfilesState
 *   POST   /api/profiles            body {name} → { id, name }   (clone du profil actif, NON activé)
 *   POST   /api/profiles/:id/activate → { ok:true }
 *   PATCH  /api/profiles/:id        body {name} → { ok:true }    (renommage)
 *   DELETE /api/profiles/:id        → { ok:true }
 *
 * Un profil capture les 9 critères de recherche/filtrage ; le cron reste global
 * (édité via /api/settings). Toute la logique vit dans `src/settings.ts`.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ProfileError,
  activateProfile,
  createProfile,
  deleteProfile,
  listProfiles,
  renameProfile,
} from "../../settings";

/** Code HTTP associé à chaque erreur métier de profil. */
const STATUS_BY_CODE = {
  INVALID_NAME: 400,
  NOT_FOUND: 404,
  LAST_PROFILE: 409,
} as const;

/** Traduit une `ProfileError` en réponse HTTP ; relance toute autre erreur. */
function sendProfileError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ProfileError) {
    return reply.code(STATUS_BY_CODE[err.code]).send({ ok: false, error: err.code });
  }
  throw err;
}

/** Extrait un `name` string non vide d'un corps de requête, ou `null`. */
function parseName(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const name = (body as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  return name;
}

export async function registerProfilesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/profiles", async () => listProfiles());

  app.post<{ Body: unknown }>("/api/profiles", async (request, reply) => {
    const name = parseName(request.body);
    if (name === null) {
      return reply.code(400).send({ ok: false, error: "INVALID_NAME" });
    }
    try {
      return createProfile(name);
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/activate", async (request, reply) => {
    try {
      activateProfile(request.params.id);
      return { ok: true };
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/profiles/:id",
    async (request, reply) => {
      const name = parseName(request.body);
      if (name === null) {
        return reply.code(400).send({ ok: false, error: "INVALID_NAME" });
      }
      try {
        renameProfile(request.params.id, name);
        return { ok: true };
      } catch (err) {
        return sendProfileError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (request, reply) => {
    try {
      deleteProfile(request.params.id);
      return { ok: true };
    } catch (err) {
      return sendProfileError(reply, err);
    }
  });
}
