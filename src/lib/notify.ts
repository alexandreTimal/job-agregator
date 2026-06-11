/**
 * Notification bureau via `notify-send` (libnotify) — best-effort STRICT.
 *
 * Utilisé par le scheduler en fin de run planifié. Si `notify-send` est absent
 * (binaire manquant) ou échoue, on logge un WARN actionnable et on n'élève
 * jamais : un run réussi ne doit pas tomber à cause d'une notif manquante.
 */
import { spawn } from "node:child_process";
import { createLogger } from "./logger";

const logger = createLogger("NOTIFY");

/** Envoie une notification bureau (titre + corps). Ne bloque pas, ne lève pas. */
export function notifyDesktop(title: string, body: string): void {
  try {
    const child = spawn("notify-send", ["--app-name=job-agregator", title, body], {
      stdio: "ignore",
    });
    child.on("error", (err) => {
      logger.warn("notify-send indisponible (notification ignorée)", { error: err.message });
    });
    // Détache la notif du cycle de vie du serveur.
    if (typeof child.unref === "function") child.unref();
  } catch (err) {
    logger.warn("notify-send a échoué (notification ignorée)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
