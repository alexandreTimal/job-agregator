/**
 * Notification bureau via `notify-send` (libnotify) — best-effort STRICT.
 *
 * Utilisé en fin de run (planifié ET manuel). Si `notify-send` est absent
 * (binaire manquant) ou échoue, on logge un WARN actionnable et on n'élève
 * jamais : un run réussi ne doit pas tomber à cause d'une notif manquante.
 */
import { spawn } from "node:child_process";
import type { RunEvent } from "../shared/types";
import { createLogger } from "./logger";

const logger = createLogger("NOTIFY");

/**
 * Construit (titre, corps) de la notification de FIN de run — fonction PURE,
 * testable sans spawn. Échec → message d'erreur ; succès → UNIQUEMENT le nombre
 * de **nouvelles offres** (`newOffers`), c.-à-d. exactement celles qui viennent
 * d'être ajoutées et apparaîtront dans la boîte « Toutes » du dashboard (non
 * doublons ET retenues par le filtre). Pas de total « trouvées » ni autre détail.
 */
export function formatRunNotification(event: RunEvent): { title: string; body: string } {
  if (event.type === "error") {
    return { title: "job-agregator — run en échec", body: event.message ?? "Erreur inconnue." };
  }
  const fresh = event.newOffers ?? 0;
  const body =
    fresh === 0 ? "Aucune nouvelle offre." : `${fresh} nouvelle${fresh > 1 ? "s" : ""} offre${fresh > 1 ? "s" : ""}.`;
  return { title: "job-agregator — recherche terminée", body };
}

/**
 * Notifie le bureau de la FIN d'un run (best-effort). Partagé par le scheduler
 * (runs planifiés) ET la route POST /api/run (runs manuels), pour que TOUS les
 * runs notifient. Une seule notif par run (verrou unique : un run est soit
 * planifié soit manuel, jamais les deux).
 */
export function notifyRunComplete(event: RunEvent): void {
  const { title, body } = formatRunNotification(event);
  notifyDesktop(title, body);
}

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
