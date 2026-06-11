/**
 * Routes de lancement du pipeline (cf. docs/api-contract.md).
 *
 *   POST /api/run         → 202 {ok:true} si démarré, 423 si run déjà en cours
 *   GET  /api/run/stream  → flux SSE de RunEvent (progress / done / error)
 *
 * Le run du pipeline est un SOUS-PROCESS : le serveur spawn `tsx src/index.ts`,
 * lit son stdout ligne par ligne, en extrait les événements préfixés `@@RUN `
 * (sérialisés par l'orchestrateur) et les rediffuse à tous les abonnés SSE.
 *
 * VERROU mémoire : un seul run à la fois. Un 2e POST pendant qu'un run tourne
 * répond 423 (Locked).
 *
 * REJEU (anti-course) : POST et GET /api/run/stream sont deux requêtes
 * distinctes. Le client ouvre l'EventSource APRÈS avoir reçu la réponse du
 * POST ; tout événement émis dans cet intervalle (premiers `progress`, voire
 * `done`/`error` d'un run rapide ou échoué d'emblée) serait perdu s'il n'était
 * que diffusé à chaud. On conserve donc le journal des événements du run
 * COURANT et on le rejoue intégralement à chaque nouvelle connexion SSE. Un run
 * terminé reste « rejouable » jusqu'au démarrage du run suivant : un stream qui
 * se connecte tard reçoit quand même l'événement terminal et se referme.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../../shared/types";

/** Préfixe des lignes de progression émises par l'orchestrateur sur stdout. */
const RUN_PREFIX = "@@RUN ";

/** Intervalle du heartbeat SSE (commentaire `: ping`) en millisecondes. */
const HEARTBEAT_MS = 15_000;

/**
 * Délai de grâce (ms) après un SIGTERM d'annulation avant d'escalader en
 * SIGKILL. Couvre le cas où npx/tsx ne relaient pas SIGTERM ou où chromium
 * traîne à se fermer : on garantit la mort du groupe et un `close` rapide.
 */
const CANCEL_GRACE_MS = 5_000;

/** Chemin du point d'entrée du pipeline relativement à ce fichier. */
const PIPELINE_ENTRY = resolve(fileURLToPath(import.meta.url), "../../../index.ts");

/**
 * Gestionnaire de run unique (verrou + diffusion SSE + rejeu), encapsulé dans
 * un module-singleton. L'état vit en mémoire serveur, conformément à l'archi.
 */
class RunManager {
  private child: ChildProcess | null = null;
  private subscribers = new Set<FastifyReply>();

  /**
   * Journal des événements du run COURANT, dans l'ordre d'émission. Rejoué tel
   * quel à chaque nouvelle connexion SSE. Réinitialisé au démarrage d'un run.
   */
  private eventLog: RunEvent[] = [];

  /**
   * Le run courant a-t-il déjà émis son événement terminal (done/error) ?
   * Permet à un stream qui se connecte tard de rejouer le terminal et de se
   * refermer, même si le sous-process est déjà mort.
   */
  private terminated = false;

  /**
   * Une annulation a-t-elle été demandée pour le run courant ? Quand le
   * sous-process se referme alors que ce flag est posé, on synthétise un
   * terminal `done` « Recherche annulée » plutôt qu'une erreur de code de sortie.
   */
  private canceling = false;

  /**
   * Minuterie d'escalade SIGKILL armée par `cancel()`. Annulée par `finish()`
   * dès que le sous-process se referme (le SIGTERM a suffi).
   */
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Rappel optionnel invoqué UNE FOIS à la fin du run courant (terminal
   * done/error), avec l'événement terminal. Posé par un déclencheur programmatique
   * (`triggerRun`, ex. le scheduler) pour notifier le bureau ; absent pour les
   * runs déclenchés via POST /api/run.
   */
  private onComplete: ((event: RunEvent) => void) | null = null;

  /** Un run est-il en cours d'exécution ? (verrou du POST /api/run) */
  get running(): boolean {
    return this.child !== null;
  }

  /**
   * Enregistre un abonné SSE : rejoue d'abord tout le journal du run courant,
   * puis — si le run est déjà terminé — referme immédiatement le flux. Sinon
   * l'abonné reste connecté et recevra les événements suivants à chaud.
   */
  subscribe(reply: FastifyReply): void {
    // Rejeu du journal courant (couvre la fenêtre de course POST → stream).
    for (const event of this.eventLog) {
      this.send(reply, event);
    }

    if (this.terminated || !this.running) {
      // Run déjà terminé (terminal rejoué ci-dessus) OU aucun run jamais lancé :
      // rien de plus à diffuser, on referme pour ne pas laisser pendre le flux.
      reply.raw.end();
      return;
    }

    this.subscribers.add(reply);
    reply.raw.on("close", () => {
      this.subscribers.delete(reply);
    });
  }

  /** Sérialise et écrit un événement SSE sur un flux donné. */
  private send(reply: FastifyReply, event: RunEvent): void {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /** Diffuse un événement à tous les abonnés SSE connectés. */
  private broadcast(event: RunEvent): void {
    for (const reply of this.subscribers) {
      this.send(reply, event);
    }
  }

  /**
   * Démarre un run si aucun n'est en cours. Renvoie false si le verrou est déjà
   * pris (le caller répondra alors 423).
   */
  start(onComplete?: (event: RunEvent) => void): boolean {
    if (this.running) return false;

    // Nouveau run : on repart d'un journal vierge et d'un état non terminé.
    this.eventLog = [];
    this.terminated = false;
    this.canceling = false;
    this.onComplete = onComplete ?? null;

    // `detached: true` fait du sous-process un LEADER de groupe : son PID est
    // aussi le PGID. À l'annulation on signale tout le groupe (`-pid`) pour tuer
    // la chaîne npx → tsx → node → chromium sans laisser de navigateur orphelin.
    const child = spawn("npx", ["tsx", PIPELINE_ENTRY], {
      cwd: resolve(fileURLToPath(import.meta.url), "../../../.."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;

    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        this.handleLine(line);
        nl = buffer.indexOf("\n");
      }
    });

    // stderr : journalisé côté serveur, non rediffusé (bruit de logs).
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      process.stderr.write(`[run] ${chunk}`);
    });

    child.on("error", (err) => {
      this.finish({ type: "error", message: err.message });
    });

    child.on("close", (code) => {
      // Si le process s'achève sans avoir émis de done/error explicite, on
      // synthétise un événement terminal cohérent avec le code de sortie.
      if (this.child !== null) {
        if (this.canceling && code !== 0) {
          // Fermeture provoquée par une annulation explicite : terminal neutre.
          // (Si `code === 0`, le run avait en fait abouti avant le signal : on
          // retombe sur la branche « run terminé » plutôt que de mentir.)
          this.finish({ type: "done", message: "Recherche annulée" });
        } else if (code === 0) {
          this.finish({ type: "done", message: "run terminé" });
        } else {
          this.finish({ type: "error", message: `run interrompu (code ${code ?? "inconnu"})` });
        }
      }
    });

    return true;
  }

  /**
   * Annule le run en cours en tuant son groupe de process. Renvoie false si
   * aucun run n'est en cours (le caller répondra alors 409). Le terminal `done`
   * « Recherche annulée » est émis par le handler `close` (cf. flag `canceling`).
   */
  cancel(): boolean {
    if (!this.running || this.child === null) return false;

    this.canceling = true;
    this.signalGroup("SIGTERM");

    // Escalade : si le groupe ne s'est pas refermé après le délai de grâce
    // (npx/tsx qui n'ont pas relayé SIGTERM, chromium lent à mourir), on force
    // en SIGKILL pour garantir la mort du groupe et un `close` rapide.
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.child !== null) this.signalGroup("SIGKILL");
    }, CANCEL_GRACE_MS);
    if (typeof this.killTimer.unref === "function") this.killTimer.unref();

    return true;
  }

  /**
   * Envoie un signal à TOUT le groupe de process du run (`-pid`), avec repli
   * best-effort sur le seul parent si le groupe n'est pas signalable.
   */
  private signalGroup(signal: NodeJS.Signals): void {
    const child = this.child;
    if (child === null) return;
    try {
      if (typeof child.pid === "number") {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Groupe déjà disparu / non signalable : repli sur le parent.
      try {
        child.kill(signal);
      } catch {
        /* process déjà mort : le handler `close` fera le ménage */
      }
    }
  }

  /** Traite une ligne de stdout : extrait et rediffuse les événements `@@RUN`. */
  private handleLine(line: string): void {
    if (!line.startsWith(RUN_PREFIX)) return;
    const json = line.slice(RUN_PREFIX.length).trim();
    let event: RunEvent;
    try {
      event = JSON.parse(json) as RunEvent;
    } catch {
      return; // ligne non JSON : on l'ignore
    }

    if (event.type === "done" || event.type === "error") {
      // Événement terminal : on le rediffuse puis on clôt proprement.
      this.finish(event);
    } else {
      this.eventLog.push(event);
      this.broadcast(event);
    }
  }

  /** Diffuse l'événement terminal, ferme les flux SSE et libère le verrou. */
  private finish(event: RunEvent): void {
    // Empêche un double-finish (close + done émis quasi simultanément).
    if (this.terminated) return;
    this.terminated = true;
    this.child = null;

    // Le sous-process s'est refermé : l'escalade SIGKILL n'a plus lieu d'être.
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }

    // Le terminal entre au journal : un stream qui se connecte après la fin du
    // run le rejouera et se refermera proprement (cf. subscribe()).
    this.eventLog.push(event);
    this.broadcast(event);
    for (const reply of this.subscribers) {
      reply.raw.end();
    }
    this.subscribers.clear();

    // Notifie le déclencheur programmatique (scheduler) une seule fois, en
    // best-effort : une notif qui échoue ne doit pas affecter le run.
    const cb = this.onComplete;
    this.onComplete = null;
    if (cb) {
      try {
        cb(event);
      } catch {
        /* best-effort : on ignore toute erreur du rappel */
      }
    }
  }
}

const manager = new RunManager();

/**
 * Déclenche un run par programme (hors HTTP), en réutilisant le verrou partagé.
 * Renvoie false si un run est déjà en cours. `onComplete` est invoqué à la fin
 * du run avec l'événement terminal (done/error). Utilisé par le scheduler.
 */
export function triggerRun(onComplete?: (event: RunEvent) => void): boolean {
  return manager.start(onComplete);
}

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  // Déclenche un run (202) ou refuse si un run est déjà en cours (423).
  app.post("/api/run", async (_request, reply) => {
    if (!manager.start()) {
      return reply.code(423).send({ ok: false, error: "run already in progress" });
    }
    return reply.code(202).send({ ok: true });
  });

  // État du run courant : permet à l'UI, après un changement de page (la page
  // Offres et son RunButton sont démontés), de savoir s'il faut se reconnecter
  // au flux SSE pour reprendre le suivi d'un run toujours en cours.
  app.get("/api/run/status", async (_request, reply) => {
    return reply.send({ running: manager.running });
  });

  // Annule le run en cours (202) ou refuse si aucun run ne tourne (409).
  app.post("/api/run/cancel", async (_request, reply) => {
    if (!manager.cancel()) {
      return reply.code(409).send({ ok: false, error: "no run in progress" });
    }
    return reply.code(202).send({ ok: true });
  });

  // Flux SSE de progression. Reste ouvert jusqu'à l'événement terminal.
  app.get("/api/run/stream", async (_request, reply) => {
    // On prend la main sur le socket brut : Fastify ne doit plus tenter de
    // sérialiser/terminer cette réponse (on pilote `reply.raw` manuellement).
    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Commentaire SSE initial : amorce la connexion côté EventSource.
    reply.raw.write(": connecté\n\n");

    // Heartbeat best-effort : maintient la connexion ouverte pendant les longs
    // runs sans événement (scraping Playwright) face aux proxys/navigateurs.
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(": ping\n\n");
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    reply.raw.on("close", () => clearInterval(heartbeat));

    // Rejoue le journal du run courant (anti-course POST → stream) puis, selon
    // l'état, garde le flux ouvert ou le referme immédiatement.
    manager.subscribe(reply);
  });
}
