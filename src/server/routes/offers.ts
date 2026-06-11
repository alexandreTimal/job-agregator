/**
 * Routes des offres (cf. docs/api-contract.md).
 *
 *   GET    /api/offers?filter=all|liked&sort=recent|score → Offer[]
 *   POST   /api/offers/:id/like   body {liked:boolean}    → {ok:true}
 *   POST   /api/offers/:id/delete                         → {ok:true} (soft-delete)
 *
 * Toute la logique d'accès vit dans `src/store/sqlite.ts` ; ces handlers ne
 * font que valider les entrées et appeler les fonctions d'accès.
 */
import type { FastifyInstance } from "fastify";
import type { OfferFilter, OfferSort } from "../../shared/types";
import { getDb, listOffers, setLiked, setDeleted } from "../../store/sqlite";

/**
 * Une offre d'identifiant donné existe-t-elle en base (deleted compris) ?
 *
 * On lit directement via le handle `getDb()` exporté par le store : la table
 * `seen_offers` n'expose pas (encore) de helper « existe par id », et le
 * périmètre de cette lane interdit de modifier `src/store/sqlite.ts`.
 */
function offerExistsById(id: number): boolean {
  const row = getDb().prepare(`SELECT 1 FROM seen_offers WHERE id = ?`).get(id);
  return row !== undefined;
}

/** Normalise le query param `filter` (défaut : `all`). */
function parseFilter(value: unknown): OfferFilter {
  return value === "liked" ? "liked" : "all";
}

/** Normalise le query param `sort` (défaut : `recent`). */
function parseSort(value: unknown): OfferSort {
  return value === "score" ? "score" : "recent";
}

/** Parse un identifiant numérique d'offre ; renvoie null si invalide. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function registerOffersRoutes(app: FastifyInstance): Promise<void> {
  // Liste des offres visibles (hors deleted = 1), filtrées et triées.
  app.get<{ Querystring: { filter?: string; sort?: string } }>(
    "/api/offers",
    async (request) => {
      const filter = parseFilter(request.query.filter);
      const sort = parseSort(request.query.sort);
      return listOffers(filter, sort);
    },
  );

  // Bascule l'état favori d'une offre.
  app.post<{ Params: { id: string }; Body: { liked?: unknown } }>(
    "/api/offers/:id/like",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ ok: false, error: "identifiant invalide" });
      }
      const liked = request.body?.liked;
      if (typeof liked !== "boolean") {
        return reply.code(400).send({ ok: false, error: "champ 'liked' booléen requis" });
      }
      if (!offerExistsById(id)) {
        return reply.code(404).send({ ok: false, error: "offre inconnue" });
      }
      setLiked(id, liked);
      return { ok: true };
    },
  );

  // Soft-delete : l'offre disparaît de l'UI mais reste connue du dédup.
  app.post<{ Params: { id: string } }>(
    "/api/offers/:id/delete",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ ok: false, error: "identifiant invalide" });
      }
      if (!offerExistsById(id)) {
        return reply.code(404).send({ ok: false, error: "offre inconnue" });
      }
      setDeleted(id);
      return { ok: true };
    },
  );
}
