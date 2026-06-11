/**
 * Session authentifiée WTTJ — source unique de vérité partagée entre la source
 * de scraping (`wttj.ts`) et l'outil de login interactif (`tools/wttj-login.ts`).
 *
 * WTTJ a déplacé sa recherche par mot-clé (`/fr/jobs-matches?classic-search=1`)
 * derrière l'authentification : un client non connecté est redirigé vers
 * `/fr/authenticate/signin`. On réutilise donc un `storageState` Playwright
 * (cookies + localStorage) exporté UNE fois via `npm run wttj:login`. Aucun mot
 * de passe ne transite par le code : l'utilisateur se connecte lui-même dans la
 * fenêtre ouverte par l'outil.
 *
 * Le fichier de session vit sous `data/` (gitignored) : c'est un secret local.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

/** UA crédible partagé login ↔ scrape : la session doit correspondre au scrape. */
export const WTTJ_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const WTTJ_LOCALE = "fr-FR";
export const WTTJ_VIEWPORT = { width: 1440, height: 900 } as const;

/** Chemin du `storageState` : `WTTJ_STORAGE_STATE` ou défaut `data/wttj-session.json`. */
export const WTTJ_STORAGE_PATH = process.env.WTTJ_STORAGE_STATE
  ? resolve(process.env.WTTJ_STORAGE_STATE)
  : resolve(PROJECT_ROOT, "data/wttj-session.json");

/** Renvoie le chemin de session s'il existe sur disque, sinon `null`. */
export function wttjStorageStateIfPresent(): string | null {
  return existsSync(WTTJ_STORAGE_PATH) ? WTTJ_STORAGE_PATH : null;
}
