/**
 * Routes de candidature par offre (cf. docs/api-contract.md).
 *
 *   POST /api/offers/:id/candidature        body {instruction?} → 202 {ok,state}
 *   GET  /api/offers/:id/candidature                            → CandidatureState
 *   GET  /api/offers/:id/candidature/cv                         → application/pdf (inline)
 *   GET  /api/offers/:id/candidature/lettre                     → text/markdown (inline)
 *   GET  /api/candidatures/stream                               → SSE CandidatureEvent
 *
 * La génération est un SOUS-PROCESS `claude` local (cf. `../candidature.ts`) :
 * plusieurs offres peuvent générer en parallèle (pas de verrou global). Ces
 * handlers ne font que valider, appeler le manager, et servir les fichiers.
 */
import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { candidatureManager, candidaturePaths, HEARTBEAT_MS } from "../candidature";
import { offerExistsById } from "../../store/sqlite";

/** Parse un identifiant numérique d'offre ; renvoie null si invalide. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function registerCandidatureRoutes(app: FastifyInstance): Promise<void> {
  // Lance (ou relance) la génération de la candidature d'une offre.
  app.post<{ Params: { id: string }; Body: { instruction?: unknown } }>(
    "/api/offers/:id/candidature",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ ok: false, error: "identifiant invalide" });
      }
      if (!offerExistsById(id)) {
        return reply.code(404).send({ ok: false, error: "offre inconnue" });
      }
      const raw = request.body?.instruction;
      const instruction = typeof raw === "string" ? raw : undefined;
      const state = candidatureManager.request(id, instruction);
      return reply.code(202).send({ ok: true, state });
    },
  );

  // État courant de la candidature d'une offre.
  app.get<{ Params: { id: string } }>(
    "/api/offers/:id/candidature",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ ok: false, error: "identifiant invalide" });
      }
      return candidatureManager.getState(id);
    },
  );

  // Sert le PDF du CV (inline, pour ouverture dans un onglet). 404 si absent.
  app.get<{ Params: { id: string } }>(
    "/api/offers/:id/candidature/cv",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ ok: false, error: "identifiant invalide" });
      }
      const { cv } = candidaturePaths(id);
      if (!existsSync(cv)) {
        return reply.code(404).send({ ok: false, error: "CV non généré" });
      }
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `inline; filename="CV_Alexandre_TIMAL_offre-${id}.pdf"`);
      reply.header("Cache-Control", "no-store");
      return reply.send(createReadStream(cv));
    },
  );

  // Sert la lettre de motivation (markdown, inline). 404 si absente.
  app.get<{ Params: { id: string } }>(
    "/api/offers/:id/candidature/lettre",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ ok: false, error: "identifiant invalide" });
      }
      const { lettre } = candidaturePaths(id);
      if (!existsSync(lettre)) {
        return reply.code(404).send({ ok: false, error: "lettre non générée" });
      }
      reply.header("Content-Type", "text/markdown; charset=utf-8");
      reply.header("Content-Disposition", `inline; filename="lettre-offre-${id}.md"`);
      reply.header("Cache-Control", "no-store");
      return reply.send(createReadStream(lettre));
    },
  );

  // Flux SSE des changements d'état de TOUTES les candidatures (instantané au
  // branchement + événements live). Reste ouvert (pas de terminal global).
  app.get("/api/candidatures/stream", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connecté\n\n");

    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(": ping\n\n");
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    reply.raw.on("close", () => clearInterval(heartbeat));

    candidatureManager.subscribe(reply);
  });
}
