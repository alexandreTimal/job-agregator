/**
 * Sonde de connectivité réseau (zéro dépendance).
 *
 * Raison d'être : le serveur (service systemd `--user`) démarre au boot du PC.
 * Si la machine ne se connecte pas automatiquement au réseau (connexion Wi-Fi
 * manuelle après login), le rattrapage de créneau manqué du scheduler partait
 * AVANT que le réseau soit disponible → toutes les sources échouaient sur
 * `getaddrinfo EAI_AGAIN` / `ERR_INTERNET_DISCONNECTED`, run gaspillé à 0 offre.
 *
 * `waitForConnectivity` poll une sonde DNS bornée pour attendre que le réseau
 * revienne avant de lancer le run. Best-effort strict : ne lève jamais, retourne
 * `false` si la fenêtre d'attente s'épuise.
 */
import { lookup } from "node:dns/promises";

/** Hôte sondé par défaut : une résolution DNS suffit à prouver le réseau. */
const DEFAULT_PROBE_HOST = "api.welcometothejungle.com";

/** Fenêtre d'attente par défaut : 60 tentatives × 10 s = ~10 min. */
const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 10_000;

export interface WaitForConnectivityOptions {
  /** Nombre maximum de sondes avant d'abandonner (défaut 60). */
  attempts?: number;
  /** Délai entre deux sondes, en ms (défaut 10 000). */
  delayMs?: number;
  /** Sonde de connectivité ; doit résoudre `true` quand le réseau est joignable. */
  probe?: () => Promise<boolean>;
  /** Fonction d'attente injectable (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Sonde par défaut : tente une résolution DNS, `false` sur toute erreur. */
async function defaultProbe(): Promise<boolean> {
  try {
    await lookup(DEFAULT_PROBE_HOST);
    return true;
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll la sonde jusqu'à son premier succès. Retourne `true` dès que le réseau
 * répond, `false` après épuisement des tentatives. Une sonde qui lève compte
 * comme un échec (pas d'exception propagée).
 */
export async function waitForConnectivity(
  opts: WaitForConnectivityOptions = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const probe = opts.probe ?? defaultProbe;
  const sleep = opts.sleep ?? defaultSleep;

  for (let i = 0; i < attempts; i++) {
    let online = false;
    try {
      online = await probe();
    } catch {
      online = false;
    }
    if (online) return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}
