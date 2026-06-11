/**
 * Capture post-mortem d'une page de scraping qui a déraillé.
 *
 * Quand une source ne trouve plus aucune carte (sélecteur racine cassé, page
 * anti-bot, captcha, redirection…), on fige l'état exact de la page sur disque :
 *  - `data/debug/<source>-<raison>-<ts>.html` : le DOM rendu, pour re-dériver le
 *    sélecteur sans avoir à relancer un scrape à la main ;
 *  - `data/debug/<source>-<raison>-<ts>.png` : un screenshot plein page, pour voir
 *    d'un coup d'œil si c'est un captcha, une page vide ou un changement de design.
 *
 * Best-effort strict : toute erreur de capture est avalée — diagnostiquer ne doit
 * jamais casser le run. Le dossier `data/` est gitignored (capture locale).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const DEBUG_DIR = resolve(PROJECT_ROOT, "data/debug");

/** Surface minimale d'une page Playwright dont on a besoin (typage structurel). */
interface CapturablePage {
  content(): Promise<string>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

/**
 * Fige HTML + screenshot de la page. Renvoie le préfixe de chemin des artefacts
 * écrits, ou `null` si la capture a échoué.
 */
export async function captureFailure(
  page: CapturablePage,
  source: string,
  reason: string,
): Promise<string | null> {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = resolve(DEBUG_DIR, `${source}-${reason}-${stamp}`);

    const html = await page.content();
    writeFileSync(`${base}.html`, html, "utf8");

    await page.screenshot({ path: `${base}.png`, fullPage: true });

    return base;
  } catch {
    return null;
  }
}
