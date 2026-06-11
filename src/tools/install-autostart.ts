/**
 * Installe l'autostart du serveur job-agregator via un service systemd `--user`.
 *
 * Génère `~/.config/systemd/user/job-agregator.service` (ExecStart = `npm run
 * start` dans le dossier projet), puis recharge et active le service. Le serveur
 * démarre alors à l'ouverture de session et reste vivant pour le scheduler cron.
 *
 * Usage : npm run autostart:install
 *
 * Note : pour démarrer AVANT toute ouverture de session (boot pur), activer le
 * « linger » : `loginctl enable-linger $USER`.
 */
import { homedir } from "node:os";
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
ExecStart=${npmPath} run start
Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;

  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(UNIT_PATH, unit, "utf8");
  console.log(`✓ Unit systemd écrite : ${UNIT_PATH}`);

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME], { stdio: "inherit" });
    console.log(`✓ Service activé et démarré : ${SERVICE_NAME}`);
    console.log(`  Statut  : systemctl --user status ${SERVICE_NAME}`);
    console.log(`  Logs    : journalctl --user -u ${SERVICE_NAME} -f`);
    console.log(`  Au boot : loginctl enable-linger $USER  (optionnel, sans login)`);
  } catch (err) {
    console.error("⚠ Unit écrite mais activation systemd échouée — à activer à la main :");
    console.error(`    systemctl --user daemon-reload`);
    console.error(`    systemctl --user enable --now ${SERVICE_NAME}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
