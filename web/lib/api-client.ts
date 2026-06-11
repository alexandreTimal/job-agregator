/**
 * Client API typé contre le contrat (`docs/api-contract.md`).
 *
 * Importe les types partagés de `src/shared/types.ts` (source de vérité).
 *
 * Mode MOCK : si `import.meta.env.VITE_MOCK === "1"`, toutes les méthodes
 * renvoient des données factices sans toucher au réseau. Cela permet de coder
 * les pages avant que le backend Fastify n'existe.
 */
import type {
  Offer,
  OfferFilter,
  OfferSort,
  Run,
  RunEvent,
  Settings,
  Stats,
} from "../../src/shared/types";

const USE_MOCK = import.meta.env.VITE_MOCK === "1";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} sur ${path}`);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Données factices (mode MOCK)                                        */
/* ------------------------------------------------------------------ */

const MOCK_OFFERS: Offer[] = [
  {
    id: 1,
    hash: "h1",
    title: "Data Engineer",
    company: "Acme",
    location: "Paris",
    url: "https://example.com/1",
    source: "wttj",
    score: 80,
    liked: true,
    appliedAt: "2026-06-11T09:00:00.000Z",
    followUpAt: "2026-06-16T12:00:00.000Z",
    publishedAt: "2026-06-10T09:00:00.000Z",
    firstSeenAt: "2026-06-10T10:00:00.000Z",
  },
  {
    id: 2,
    hash: "h2",
    title: "Machine Learning Engineer",
    company: "Globex",
    location: "Remote",
    url: "https://example.com/2",
    source: "hellowork",
    score: 60,
    liked: false,
    appliedAt: null,
    followUpAt: null,
    publishedAt: null,
    firstSeenAt: "2026-06-11T08:00:00.000Z",
  },
];

const MOCK_SETTINGS: Settings = {
  terms: ["data engineer", "machine learning engineer"],
  contractTypes: ["CDI"],
  enabledSources: ["wttj", "hellowork"],
  atsBoards: { greenhouse: ["stripe"], lever: ["swile"] },
  salaryMin: 45000,
  locations: ["Paris", "Lyon"],
  remoteOk: true,
  maxOfferAgeDays: 7,
  cronEnabled: false,
  cronTimes: ["08:00", "20:00"],
};

const MOCK_RUNS: Run[] = [
  {
    id: 1,
    startedAt: "2026-06-11T08:00:00.000Z",
    durationMs: 41230,
    found: 50,
    new: 6,
    duplicates: 44,
    perSource: { wttj: 30, hellowork: 20 },
  },
];

const MOCK_STATS: Stats = {
  today: 3,
  week: 18,
  duplicates: 44,
  bySource: [
    { source: "wttj", count: 12, logo: "/logos/wttj.svg" },
    { source: "hellowork", count: 6, logo: "/logos/hellowork.svg" },
  ],
  byLocation: [
    { label: "Paris", count: 9 },
    { label: "Lyon", count: 4 },
    { label: "Autres", count: 3 },
    { label: "Non précisé", count: 2 },
  ],
  byContract: [
    { label: "CDI", count: 13 },
    { label: "Stage", count: 5 },
  ],
  lastRuns: MOCK_RUNS,
};

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export const apiClient = {
  async getOffers(filter: OfferFilter = "all", sort: OfferSort = "recent"): Promise<Offer[]> {
    if (USE_MOCK) {
      let list = MOCK_OFFERS;
      if (filter === "liked") list = MOCK_OFFERS.filter((o) => o.liked);
      else if (filter === "applied") list = MOCK_OFFERS.filter((o) => o.appliedAt !== null);
      return Promise.resolve([...list]);
    }
    const params = new URLSearchParams({ filter, sort });
    return http<Offer[]>(`/api/offers?${params.toString()}`);
  },

  async likeOffer(id: number, liked: boolean): Promise<{ ok: true }> {
    if (USE_MOCK) return Promise.resolve({ ok: true });
    return http<{ ok: true }>(`/api/offers/${id}/like`, {
      method: "POST",
      body: JSON.stringify({ liked }),
    });
  },

  /**
   * Marque/démarque une offre comme « postulée ». Renvoie les dates recalculées
   * côté serveur (`appliedAt` + relance dérivée), pour une MAJ optimiste sans
   * rechargement de la liste.
   */
  async applyOffer(
    id: number,
    applied: boolean,
  ): Promise<{ ok: true; appliedAt: string | null; followUpAt: string | null }> {
    if (USE_MOCK) {
      const followUpAt = applied ? "2026-06-16T12:00:00.000Z" : null;
      return Promise.resolve({
        ok: true,
        appliedAt: applied ? "2026-06-11T09:00:00.000Z" : null,
        followUpAt,
      });
    }
    return http<{ ok: true; appliedAt: string | null; followUpAt: string | null }>(
      `/api/offers/${id}/applied`,
      { method: "POST", body: JSON.stringify({ applied }) },
    );
  },

  async deleteOffer(id: number): Promise<{ ok: true }> {
    if (USE_MOCK) return Promise.resolve({ ok: true });
    return http<{ ok: true }>(`/api/offers/${id}/delete`, { method: "POST" });
  },

  async getSettings(): Promise<Settings> {
    if (USE_MOCK) return Promise.resolve({ ...MOCK_SETTINGS });
    return http<Settings>(`/api/settings`);
  },

  async setSettings(settings: Settings): Promise<{ ok: true }> {
    if (USE_MOCK) return Promise.resolve({ ok: true });
    return http<{ ok: true }>(`/api/settings`, {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },

  async getStats(): Promise<Stats> {
    if (USE_MOCK) return Promise.resolve({ ...MOCK_STATS });
    return http<Stats>(`/api/stats`);
  },

  /** Démarre un run. Renvoie `false` si un run est déjà en cours (HTTP 423). */
  async startRun(): Promise<boolean> {
    if (USE_MOCK) return Promise.resolve(true);
    const res = await fetch(`/api/run`, { method: "POST" });
    if (res.status === 423) return false;
    if (!res.ok) throw new Error(`HTTP ${res.status} sur /api/run`);
    return true;
  },

  /**
   * Indique si un run est en cours côté serveur. Utilisé au montage du
   * RunButton (après un changement de page) pour décider de se reconnecter au
   * flux SSE et reprendre le suivi.
   */
  async getRunStatus(): Promise<{ running: boolean }> {
    if (USE_MOCK) return Promise.resolve({ running: false });
    return http<{ running: boolean }>(`/api/run/status`);
  },

  /**
   * Annule le run en cours. Renvoie `true` si l'annulation a été acceptée (202),
   * `false` si aucun run n'était en cours côté serveur (HTTP 409).
   */
  async cancelRun(): Promise<boolean> {
    if (USE_MOCK) return Promise.resolve(true);
    const res = await fetch(`/api/run/cancel`, { method: "POST" });
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`HTTP ${res.status} sur /api/run/cancel`);
    return true;
  },

  /**
   * Ouvre le flux SSE de progression. Renvoie une fonction de fermeture.
   * En mode MOCK, simule quelques événements puis `done`.
   */
  streamRun(onEvent: (event: RunEvent) => void): () => void {
    if (USE_MOCK) {
      const timers: ReturnType<typeof setTimeout>[] = [];
      timers.push(
        setTimeout(() => onEvent({ type: "progress", term: "data engineer", source: "wttj", found: 12 }), 200),
      );
      timers.push(setTimeout(() => onEvent({ type: "done", message: "run terminé" }), 600));
      return () => timers.forEach(clearTimeout);
    }
    const es = new EventSource(`/api/run/stream`);
    // Vrai quand un événement terminal (done/error) a déjà été reçu : on ne veut
    // pas qu'un `onerror` déclenché par la fermeture normale du flux par le
    // serveur (juste après `done`) soit interprété comme une erreur.
    let termine = false;
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as RunEvent;
        if (event.type === "done" || event.type === "error") termine = true;
        onEvent(event);
      } catch {
        /* ignore les messages non JSON */
      }
    };
    es.onerror = () => {
      // Coupure AVANT tout terminal (process tué, serveur crashé) : on remonte
      // un événement `error` pour que l'appelant réarme aussitôt, au lieu de
      // rester silencieux et de dépendre du chien de garde côté UI.
      if (!termine) {
        termine = true;
        onEvent({ type: "error", message: "connexion au flux de progression interrompue" });
      }
      es.close();
    };
    return () => es.close();
  },
};
