/**
 * Outil de connexion WTTJ — à lancer UNE fois (et à re-lancer quand la session
 * expire) : `npm run wttj:login`.
 *
 * Ouvre une fenêtre Chromium VISIBLE sur la page de connexion WTTJ. Tu te
 * connectes toi-même (email + mot de passe, ou « Continuer avec … »), puis tu
 * reviens dans le terminal et appuies sur Entrée. La session (cookies +
 * localStorage) est alors exportée dans un `storageState` Playwright que la
 * source `wttj.ts` réutilisera pour scraper la recherche par mot-clé.
 *
 * Aucun mot de passe ne transite par ce code : la saisie se fait dans le
 * navigateur, jamais dans le terminal ni dans un fichier du repo. Le fichier de
 * session vit sous `data/` (gitignored) — c'est un secret local.
 *
 * Pré-requis : un environnement graphique (le navigateur s'ouvre en mode visible).
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { WTTJ_UA, WTTJ_LOCALE, WTTJ_VIEWPORT, WTTJ_STORAGE_PATH } from "../sources/wttj-session";

chromium.use(StealthPlugin());

const SIGNIN_URL = "https://www.welcometothejungle.com/fr/authenticate/signin";

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  try {
    const context = await browser.newContext({
      userAgent: WTTJ_UA,
      locale: WTTJ_LOCALE,
      viewport: { ...WTTJ_VIEWPORT },
    });
    const page = await context.newPage();
    await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });

    stdout.write(
      "\n  Une fenêtre WTTJ s'est ouverte.\n" +
        "  → Connecte-toi (email + mot de passe, ou « Continuer avec … »).\n" +
        "  → Une fois connecté (tu vois ton espace / tes offres), reviens ici.\n\n",
    );

    const rl = createInterface({ input: stdin, output: stdout });
    await rl.question("  Appuie sur Entrée pour enregistrer la session… ");
    rl.close();

    mkdirSync(dirname(WTTJ_STORAGE_PATH), { recursive: true });
    await context.storageState({ path: WTTJ_STORAGE_PATH });

    stdout.write(`\n  ✓ Session enregistrée : ${WTTJ_STORAGE_PATH}\n` + "  Tu peux relancer un run : `npm run fetch`.\n\n");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  stdout.write(`\n  ✗ Échec : ${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});
