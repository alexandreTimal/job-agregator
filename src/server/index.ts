/**
 * Serveur web LOCAL de job-agregator.
 *
 * Responsabilités :
 * - Fastify lié à 127.0.0.1 uniquement (mono-utilisateur, accès local).
 * - Enregistre les routes métier de `./routes` (offers, settings, stats, run).
 * - Sert les assets statiques `public/` (dont public/logos/*.svg).
 * - Sert le SPA buildé par Vite (`web/dist`) avec repli SPA (index.html) sur
 *   les routes inconnues qui ne sont pas de l'API.
 *
 * Le serveur initialise aussi la base sqlite (schéma + seed paresseux des
 * settings) au démarrage, pour que l'UI soit fonctionnelle dès le premier lancement.
 */
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerRoutes } from "./routes/index";
import { initDb } from "../store/sqlite";
import { seedSettingsIfEmpty } from "../settings";

const HOST = "127.0.0.1";
// 3000 par défaut (mode `npm run start`, site servi par Fastify). En dev, le
// script `dev:server` force PORT=3001 pour laisser le 3000 à Vite (HMR).
const PORT = Number(process.env.PORT ?? 3000);

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const PROJECT_ROOT = resolve(__dirname, "../..");
const PUBLIC_DIR = resolve(PROJECT_ROOT, "public");
const WEB_DIST_DIR = resolve(PROJECT_ROOT, "web/dist");

export async function buildServer() {
  // `disableRequestLogging` coupe les lignes auto « incoming request » /
  // « request completed » (très bruyantes, surtout les 304 du polling SSE)
  // tout en gardant le logger pour les vrais logs métier/erreurs.
  const app = Fastify({ logger: true, disableRequestLogging: true });

  // Base sqlite prête (schéma + seed initial des settings).
  initDb();
  seedSettingsIfEmpty();

  // Routes métier de l'API.
  await registerRoutes(app);

  // Assets statiques servis au préfixe « / » : on combine en UNE SEULE
  // inscription `@fastify/static` les racines existantes (SPA buildé + dossier
  // public). Enregistrer deux fois le même préfixe provoquerait une collision de
  // route (`Method 'HEAD' already declared for route '/*'`). `@fastify/static`
  // accepte un tableau de racines, parcourues dans l'ordre : web/dist d'abord
  // (index.html, assets), puis public/ (logos des sources).
  const staticRoots = [WEB_DIST_DIR, PUBLIC_DIR].filter((dir) => existsSync(dir));
  if (staticRoots.length > 0) {
    await app.register(fastifyStatic, {
      root: staticRoots,
      prefix: "/",
      decorateReply: true,
    });
  }

  // Repli SPA : toute route non-API inconnue renvoie index.html (routage client).
  if (existsSync(WEB_DIST_DIR)) {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ ok: false, error: "route inconnue" });
      }
      return reply.sendFile("index.html", WEB_DIST_DIR);
    });
  }

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();
  await app.listen({ host: HOST, port: PORT });
}

// Démarrage direct uniquement si exécuté en script (pas à l'import).
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
