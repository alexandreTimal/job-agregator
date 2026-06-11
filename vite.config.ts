import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Config Vite pour l'UI locale (dossier `web/`).
 *
 * - `root` = web/ (index.html y vit).
 * - En dev, proxy des appels `/api` et `/logos` vers le serveur Fastify.
 * - Build émis dans `web/dist`, servi en prod par Fastify.
 */
const SERVER_PORT = Number(process.env.PORT ?? 5174);

export default defineConfig({
  root: resolve(__dirname, "web"),
  plugins: [react()],
  publicDir: resolve(__dirname, "public"),
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${SERVER_PORT}`,
      "/logos": `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
  build: {
    outDir: resolve(__dirname, "web/dist"),
    emptyOutDir: true,
  },
});
