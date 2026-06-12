/**
 * Installe l'autostart du serveur job-agregator via un service systemd `--user`.
 *
 * Génère `~/.config/systemd/user/job-agregator.service` (ExecStart = `npm run
 * serve` dans le dossier projet), puis recharge et active le service. Le serveur
 * démarre alors à l'ouverture de session et reste vivant pour le scheduler cron.
 *
 * Le SPA est buildé UNE FOIS ici (`npm run build`), pas dans `ExecStart` : un
 * service qui rebuild à chaque (re)démarrage laisserait une fenêtre de ~20 s
 * sans serveur en écoute (`Restart=on-failure` → rebuild → port mort), pendant
 * laquelle les requêtes du navigateur échouent. `ExecStart=npm run serve` ne
 * fait donc que servir `web/dist` déjà buildé. Après un changement de code
 * frontend, relancer `npm run build` (ou `npm run autostart:install`).
 *
 * Usage : npm run autostart:install
 *
 * Le « linger » (`loginctl enable-linger $USER`) est activé automatiquement :
 * sans lui, un service `--user` ne démarre qu'à l'ouverture de session, pas au
 * boot pur — le scheduler cron raterait alors les créneaux tant que personne ne
 * s'est connecté. Best-effort : si l'activation échoue (polkit), on l'indique.
 */
import { homedir, userInfo } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE_NAME = "job-agregator.service";
const UNIT_DIR = resolve(homedir(), ".config/systemd/user");
const UNIT_PATH = resolve(UNIT_DIR, SERVICE_NAME);

/** Chemin absolu d'un binaire via `which`, ou le nom brut en repli. */
function which(bin: string): string {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim();
  } catch {
    return bin;
  }
}

function main(): void {
  const npmPath = which("npm");
  const nodeDir = dirname(which("node"));

  const unit = `[Unit]
Description=job-agregator — agrégateur de jobboards local (serveur + scheduler cron)
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${npmPath} run serve
Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;

  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(UNIT_PATH, unit, "utf8");
  console.log(`✓ Unit systemd écrite : ${UNIT_PATH}`);

  // Build UNIQUE du SPA ici (et non dans ExecStart) : le service ne fait plus
  // que servir `web/dist`, sans fenêtre morte au (re)démarrage. Échec de build
  // = on s'arrête : inutile d'activer un service qui servirait un SPA absent.
  try {
    console.log("• Build du SPA (npm run build)…");
    execFileSync(npmPath, ["run", "build"], { cwd: PROJECT_ROOT, stdio: "inherit" });
    console.log("✓ SPA buildé : web/dist");
  } catch (err) {
    console.error("⚠ Build du SPA échoué — service non activé. Corriger puis relancer.");
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // Linger : permet au gestionnaire systemd --user de tourner dès le boot, sans
  // attendre une ouverture de session — sinon le scheduler cron raterait les
  // créneaux jusqu'au premier login. Best-effort : sur certains systèmes polkit
  // exige une élévation, on n'échoue pas l'install pour autant.
  const user = userInfo().username;
  try {
    execFileSync("loginctl", ["enable-linger", user], { stdio: "inherit" });
    console.log(`✓ Linger activé pour ${user} (démarrage au boot, sans login)`);
  } catch {
    console.warn(`⚠ Linger non activé automatiquement — à lancer une fois pour un démarrage au boot pur :`);
    console.warn(`    sudo loginctl enable-linger ${user}`);
  }

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME], { stdio: "inherit" });
    console.log(`✓ Service activé et démarré : ${SERVICE_NAME}`);
    console.log(`  Statut  : systemctl --user status ${SERVICE_NAME}`);
    console.log(`  Logs    : journalctl --user -u ${SERVICE_NAME} -f`);
  } catch (err) {
    console.error("⚠ Unit écrite mais activation systemd échouée — à activer à la main :");
    console.error(`    systemctl --user daemon-reload`);
    console.error(`    systemctl --user enable --now ${SERVICE_NAME}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
