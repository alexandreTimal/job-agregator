import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Config Vite pour l'UI locale (dossier `web/`).
 *
 * Projet perso : pas de serveur de dev Vite. On build seulement ; c'est Fastify
 * qui sert le résultat (`web/dist`) + l'API sur le port 5627 (`npm run start`).
 *
 * - `root` = web/ (index.html y vit).
 * - Build émis dans `web/dist`.
 */
export default defineConfig({
  root: resolve(__dirname, "web"),
  plugins: [react(), tailwindcss()],
  publicDir: resolve(__dirname, "public"),
  resolve: {
    alias: {
      "@": resolve(__dirname, "web"),
    },
  },
  build: {
    outDir: resolve(__dirname, "web/dist"),
    emptyOutDir: true,
  },
});
