/**
 * Logger du pipeline — pensé pour DIAGNOSTIQUER vite les pannes de scraping/parsing.
 *
 * Deux destinations à chaque ligne :
 *  - **stderr** : visible dans le terminal. On écrit volontairement sur stderr
 *    (et non stdout) car stdout est réservé au protocole SSE `@@RUN ` émis par
 *    l'orchestrateur ; mélanger les deux corromprait le flux relayé par le serveur.
 *  - **fichier `data/logs/run-<timestamp>.log`** : un fichier par process, décidé
 *    une fois au démarrage et partagé par tous les loggers (toutes sources). Les
 *    logs survivent au run → on peut les `grep` après coup pour comprendre un bug.
 *
 * Niveaux : DEBUG < INFO < WARN < ERROR. Le seuil par défaut est INFO ; passer
 * `LOG_LEVEL=debug` (env) pour voir le détail par page/par carte.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

const envLevel = process.env.LOG_LEVEL?.toUpperCase() as LogLevel | undefined;
const THRESHOLD = ORDER[envLevel ?? "INFO"] ?? ORDER.INFO;

// Un seul fichier de log par process, résolu paresseusement au premier log.
let logFile: string | null = null;
function resolveLogFile(): string {
  if (logFile) return logFile;
  const dir = resolve(PROJECT_ROOT, "data/logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort : si le disque refuse, on garde au moins stderr */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  logFile = resolve(dir, `run-${stamp}.log`);
  return logFile;
}

/** Chemin du fichier de log du run courant (pour l'annoncer au démarrage). */
export function logFilePath(): string {
  return resolveLogFile();
}

export function createLogger(source: string) {
  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    if (ORDER[level] < THRESHOLD) return;

    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    const line = `[${timestamp}] [${source}] ${level}: ${message}${metaStr}`;

    process.stderr.write(`${line}\n`);
    try {
      appendFileSync(resolveLogFile(), `${line}\n`);
    } catch {
      /* best-effort : un échec d'écriture fichier ne doit jamais casser un run */
    }
  };

  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log("DEBUG", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => log("INFO", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("WARN", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("ERROR", msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
