/**
 * Enregistrement des routes de l'API (cf. docs/api-contract.md).
 *
 * Câble le CONTRAT en réutilisant les fonctions d'accès de
 * `src/store/sqlite.ts` et `src/settings.ts`, et les types partagés de
 * `src/shared/types.ts`.
 *
 * Routes :
 *   GET    /api/offers
 *   POST   /api/offers/:id/like
 *   POST   /api/offers/:id/delete
 *   GET    /api/settings
 *   PUT    /api/settings
 *   GET    /api/stats
 *   POST   /api/run            (202 / 423)
 *   GET    /api/run/stream     (SSE)
 */
import type { FastifyInstance } from "fastify";
import { registerOffersRoutes } from "./offers";
import { registerSettingsRoutes } from "./settings";
import { registerStatsRoutes } from "./stats";
import { registerRunRoutes } from "./run";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Sonde de santé (utile au dev / aux tests de fumée).
  app.get("/api/health", async () => ({ ok: true }));

  await registerOffersRoutes(app);
  await registerSettingsRoutes(app);
  await registerStatsRoutes(app);
  await registerRunRoutes(app);
}
