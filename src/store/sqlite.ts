import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer, OfferFilter, OfferSort, Run, Stats, SourceCount } from "../shared/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, "../../data/job-agregator.db");
const DB_PATH = process.env.JOB_AGREGATOR_DB
  ? resolve(process.env.JOB_AGREGATOR_DB)
  : DEFAULT_DB_PATH;

let db: Database.Database | null = null;

/** Ajoute une colonne si elle n'existe pas déjà (migration idempotente). */
function ensureColumn(database: Database.Database, column: string, ddl: string): void {
  const cols = database.prepare(`PRAGMA table_info(seen_offers)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE seen_offers ADD COLUMN ${ddl}`);
  }
}

export function initDb(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      company TEXT,
      location TEXT,
      url TEXT,
      source TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notified_notion BOOLEAN DEFAULT 0,
      liked BOOLEAN DEFAULT 0,
      deleted BOOLEAN DEFAULT 0,
      published_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_seen_hash ON seen_offers(hash);
    CREATE INDEX IF NOT EXISTS idx_seen_date ON seen_offers(first_seen_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      duration_ms INTEGER,
      found INTEGER,
      new INTEGER,
      duplicates INTEGER,
      per_source TEXT
    );
  `);

  // Migrations idempotentes pour les bases déjà créées avant ces colonnes.
  ensureColumn(db, "location", "location TEXT");
  ensureColumn(db, "liked", "liked BOOLEAN DEFAULT 0");
  ensureColumn(db, "deleted", "deleted BOOLEAN DEFAULT 0");
  ensureColumn(db, "published_at", "published_at DATETIME");

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    return initDb();
  }
  return db;
}

/* ------------------------------------------------------------------ */
/* Dédup (API existante conservée)                                     */
/* ------------------------------------------------------------------ */

/** Offre déjà vue (toutes sessions confondues) dans la fenêtre donnée ? */
export function isOfferSeen(hash: string, windowDays: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM seen_offers WHERE hash = ? AND first_seen_at > datetime('now', ?)`,
    )
    .get(hash, `-${windowDays} days`);
  return row !== undefined;
}

/** Une offre est-elle déjà connue de la base (peu importe deleted) ? */
export function offerExists(hash: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM seen_offers WHERE hash = ?`).get(hash);
  return row !== undefined;
}

export function insertOffer(offer: {
  hash: string;
  title: string;
  company: string | null;
  location?: string | null;
  url: string;
  source: string;
  score: number;
  publishedAt?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO seen_offers (hash, title, company, location, url, source, score, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      offer.hash,
      offer.title,
      offer.company,
      offer.location ?? null,
      offer.url,
      offer.source,
      offer.score,
      offer.publishedAt ?? null,
    );
}

/** @deprecated `notified_notion` est obsolète (Notion supprimé). Conservé pour compat. */
export function markNotifiedNotion(hash: string): void {
  getDb().prepare(`UPDATE seen_offers SET notified_notion = 1 WHERE hash = ?`).run(hash);
}

/** @deprecated `notified_notion` est obsolète (Notion supprimé). Conservé pour compat. */
export function isNotifiedNotion(hash: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM seen_offers WHERE hash = ? AND notified_notion = 1`)
    .get(hash);
  return row !== undefined;
}

/* ------------------------------------------------------------------ */
/* Accès UI : offres                                                   */
/* ------------------------------------------------------------------ */

interface OfferRow {
  id: number;
  hash: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string | null;
  source: string;
  score: number;
  liked: number;
  published_at: string | null;
  first_seen_at: string;
}

function rowToOffer(r: OfferRow): Offer {
  return {
    id: r.id,
    hash: r.hash,
    title: r.title,
    company: r.company,
    location: r.location,
    url: r.url ?? "",
    source: r.source,
    score: r.score,
    liked: r.liked === 1,
    publishedAt: r.published_at,
    firstSeenAt: r.first_seen_at,
  };
}

/**
 * Liste les offres pour l'UI (hors `deleted = 1`).
 * Les favoris (`liked = 1`) remontent toujours en tête, quel que soit le tri.
 */
export function listOffers(filter: OfferFilter, sort: OfferSort): Offer[] {
  const where = filter === "liked" ? "deleted = 0 AND liked = 1" : "deleted = 0";
  const secondary =
    sort === "score"
      ? "score DESC, COALESCE(published_at, first_seen_at) DESC"
      : "COALESCE(published_at, first_seen_at) DESC";

  const rows = getDb()
    .prepare(
      `SELECT id, hash, title, company, location, url, source, score, liked, published_at, first_seen_at
       FROM seen_offers
       WHERE ${where}
       ORDER BY liked DESC, ${secondary}`,
    )
    .all() as OfferRow[];

  return rows.map(rowToOffer);
}

/** Une offre d'identifiant numérique donné existe-t-elle en base (deleted compris) ? */
export function offerExistsById(id: number): boolean {
  const row = getDb().prepare(`SELECT 1 FROM seen_offers WHERE id = ?`).get(id);
  return row !== undefined;
}

export function setLiked(id: number, liked: boolean): void {
  getDb().prepare(`UPDATE seen_offers SET liked = ? WHERE id = ?`).run(liked ? 1 : 0, id);
}

/** Soft-delete : l'offre disparaît de l'UI mais reste connue du dédup. */
export function setDeleted(id: number): void {
  getDb().prepare(`UPDATE seen_offers SET deleted = 1 WHERE id = ?`).run(id);
}

/* ------------------------------------------------------------------ */
/* Settings (clé/valeur)                                               */
/* ------------------------------------------------------------------ */

/** Lit toutes les paires clé/valeur brutes de la table `settings`. */
export function getSettingsRaw(): Record<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM settings`).all() as {
    key: string;
    value: string;
  }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/** Écrit (upsert) une paire clé/valeur. */
export function setSettingRaw(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

/** True si la table settings est vide (sert au seed initial). */
export function settingsEmpty(): boolean {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM settings`).get() as { n: number };
  return row.n === 0;
}

/* ------------------------------------------------------------------ */
/* Runs + stats                                                        */
/* ------------------------------------------------------------------ */

/** Insère une ligne de run et renvoie son id. */
export function insertRun(run: {
  startedAt: number;
  durationMs: number | null;
  found: number;
  new: number;
  duplicates: number;
  perSource: Record<string, number>;
}): number {
  // `started_at` reflète le DÉBUT réel du run, pas l'instant de l'INSERT (qui a
  // lieu en fin de run et donnait, via DEFAULT CURRENT_TIMESTAMP, l'heure de fin).
  // Stocké en UTC au même format texte que CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS")
  // pour rester compatible avec strftime/ORDER BY et le parsing UTC côté UI.
  const startedAtUtc = new Date(run.startedAt).toISOString().slice(0, 19).replace("T", " ");
  const info = getDb()
    .prepare(
      `INSERT INTO runs (started_at, duration_ms, found, new, duplicates, per_source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      startedAtUtc,
      run.durationMs,
      run.found,
      run.new,
      run.duplicates,
      JSON.stringify(run.perSource),
    );
  return Number(info.lastInsertRowid);
}

/**
 * Timestamp (ms epoch) du run le plus récent, ou `null` si aucun run.
 * `started_at` est stocké en UTC (`CURRENT_TIMESTAMP`) : on le convertit en
 * epoch via strftime pour éviter toute ambiguïté de fuseau côté JS.
 */
export function getLastRunAtMs(): number | null {
  const row = getDb()
    .prepare(
      `SELECT CAST(strftime('%s', started_at) AS INTEGER) AS epoch
       FROM runs ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get() as { epoch: number | null } | undefined;
  if (!row || row.epoch === null) return null;
  return row.epoch * 1000;
}

interface RunRow {
  id: number;
  started_at: string;
  duration_ms: number | null;
  found: number;
  new: number;
  duplicates: number;
  per_source: string | null;
}

function rowToRun(r: RunRow): Run {
  let perSource: Record<string, number> = {};
  if (r.per_source) {
    try {
      perSource = JSON.parse(r.per_source) as Record<string, number>;
    } catch {
      perSource = {};
    }
  }
  return {
    id: r.id,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    found: r.found,
    new: r.new,
    duplicates: r.duplicates,
    perSource,
  };
}

/** Chemin du logo local d'une source (asset servi par le serveur web). */
function logoPath(source: string): string {
  return `/logos/${source}.svg`;
}

/**
 * Statistiques pour l'UI : offres aujourd'hui / sur 7 jours, doublons cumulés,
 * répartition par source, et derniers runs.
 */
export function getStats(): Stats {
  const database = getDb();

  const today = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM seen_offers
         WHERE deleted = 0 AND first_seen_at >= datetime('now', 'start of day')`,
      )
      .get() as { n: number }
  ).n;

  const week = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM seen_offers
         WHERE deleted = 0 AND first_seen_at > datetime('now', '-7 days')`,
      )
      .get() as { n: number }
  ).n;

  const duplicates = (
    database.prepare(`SELECT COALESCE(SUM(duplicates), 0) AS n FROM runs`).get() as { n: number }
  ).n;

  const bySourceRows = database
    .prepare(
      `SELECT source, COUNT(*) AS count FROM seen_offers
       WHERE deleted = 0
       GROUP BY source
       ORDER BY count DESC`,
    )
    .all() as { source: string; count: number }[];

  const bySource: SourceCount[] = bySourceRows.map((r) => ({
    source: r.source,
    count: r.count,
    logo: logoPath(r.source),
  }));

  const lastRuns = (
    database
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 10`)
      .all() as RunRow[]
  ).map(rowToRun);

  return { today, week, duplicates, bySource, lastRuns };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
