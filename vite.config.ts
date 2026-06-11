import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Config Vite pour l'UI locale (dossier `web/`).
 *
 * - `root` = web/ (index.html y vit).
 * - En dev, l'UI est servie par Vite sur le port 3000 (l'URL à ouvrir), et les
 *   appels `/api` et `/logos` sont proxyés vers le serveur Fastify (port 3001
 *   en dev — voir le script `dev:server`).
 * - Build émis dans `web/dist`, servi en prod par Fastify (port 3000).
 */
const API_PORT = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  root: resolve(__dirname, "web"),
  plugins: [react()],
  publicDir: resolve(__dirname, "public"),
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/api": `http://127.0.0.1:${API_PORT}`,
      "/logos": `http://127.0.0.1:${API_PORT}`,
    },
  },
  build: {
    outDir: resolve(__dirname, "web/dist"),
    emptyOutDir: true,
  },
});
