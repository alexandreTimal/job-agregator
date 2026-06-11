/**
 * Scheduler in-process : déclenche le pipeline aux horaires "HH:MM" configurés
 * (`settings.cronTimes`) tant que `settings.cronEnabled` est vrai.
 *
 * Vit dans le process serveur long — maintenu vivant par le service systemd
 * `--user` (cf. `npm run autostart:install`). Il NE duplique PAS la logique de
 * lancement : il réutilise le `RunManager` via `triggerRun` (verrou partagé →
 * jamais deux runs concurrents). En fin de run planifié, il envoie une
 * notification bureau avec le nombre de nouvelles offres.
 *
 * Cycle de vie (singleton) : `start()` au boot, `reload()` après un
 * PUT /api/settings, `stop()` à l'arrêt du serveur.
 */
import type { RunEvent } from "../shared/types";
import { getSettings } from "../settings";
import { getLastRunAtMs } from "../store/sqlite";
import { triggerRun } from "./routes/run";
import { nextFireDelay, shouldCatchUp } from "../lib/cron-schedule";
import { notifyDesktop } from "../lib/notify";
import { createLogger } from "../lib/logger";

const logger = createLogger("SCHEDULER");

class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Démarrage serveur : rattrape d'abord un éventuel créneau manqué (PC éteint
   * au moment d'un horaire planifié), puis arme le prochain timer.
   */
  start(): void {
    this.catchUpIfMissed();
    this.arm();
  }

  /** Recharge la planification (à appeler après un PUT /api/settings). */
  reload(): void {
    this.arm();
  }

  /** Désarme complètement (arrêt serveur). */
  stop(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Rattrapage au boot : si un créneau planifié est passé pendant que l'app
   * était éteinte (dernier run antérieur au dernier créneau écoulé), déclenche
   * UN run immédiat pour rester à jour. Best-effort, jamais bloquant.
   */
  private catchUpIfMissed(): void {
    const settings = getSettings();
    if (!settings.cronEnabled) return;

    const lastMs = getLastRunAtMs();
    const lastRunAt = lastMs === null ? null : new Date(lastMs);
    if (!shouldCatchUp(lastRunAt, new Date(), settings.cronTimes)) return;

    logger.info("Créneau manqué détecté au démarrage : rattrapage du run", {
      dernierRun: lastRunAt?.toISOString() ?? "jamais",
      horaires: settings.cronTimes,
    });
    const started = triggerRun((event) => this.onRunComplete(event));
    if (!started) logger.warn("Rattrapage ignoré : un run est déjà en cours");
  }

  /** Calcule le prochain créneau et arme un timer unique vers `fire()`. */
  private arm(): void {
    this.clear();
    const settings = getSettings();

    if (!settings.cronEnabled) {
      logger.info("Cron désactivé : aucun run planifié");
      return;
    }

    const delay = nextFireDelay(new Date(), settings.cronTimes);
    if (delay === null) {
      logger.warn("Cron activé mais aucun horaire valide : rien à planifier", {
        cronTimes: settings.cronTimes,
      });
      return;
    }

    logger.info("Prochain run planifié", {
      dansMinutes: Math.round(delay / 60_000),
      horaires: settings.cronTimes,
    });
    this.timer = setTimeout(() => this.fire(), delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Déclenche un run via le RunManager partagé, puis réarme. */
  private fire(): void {
    this.timer = null;
    const started = triggerRun((event) => this.onRunComplete(event));
    if (started) {
      logger.info("Run planifié déclenché");
    } else {
      // Verrou pris (run manuel ou planifié déjà en cours) : on saute ce tick.
      logger.warn("Tick planifié ignoré : un run est déjà en cours");
    }
    // Réarme pour le créneau suivant, qu'on ait déclenché ou non.
    this.arm();
  }

  /** Notification bureau de fin de run planifié (best-effort). */
  private onRunComplete(event: RunEvent): void {
    if (event.type === "error") {
      notifyDesktop("job-agregator — run en échec", event.message ?? "Erreur inconnue.");
      return;
    }
    const n = event.newOffers ?? 0;
    const body = n === 0 ? "Aucune nouvelle offre." : `${n} nouvelle${n > 1 ? "s" : ""} offre${n > 1 ? "s" : ""}.`;
    notifyDesktop("job-agregator — recherche terminée", body);
  }
}

let instance: Scheduler | null = null;

/** Singleton du scheduler serveur. */
export function getScheduler(): Scheduler {
  if (instance === null) instance = new Scheduler();
  return instance;
}
