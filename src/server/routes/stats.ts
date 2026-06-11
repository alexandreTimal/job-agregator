/**
 * Route des statistiques (cf. docs/api-contract.md).
 *
 *   GET /api/stats → Stats
 *
 * Tout le calcul (offres du jour / 7 jours, doublons cumulés, répartition par
 * source, derniers runs) est centralisé dans `getStats()` du store sqlite.
 */
import type { FastifyInstance } from "fastify";
import { getStats } from "../../store/sqlite";

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stats", async () => getStats());
}
