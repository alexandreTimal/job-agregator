/**
 * Page Stats.
 *
 * Affiche les statistiques agrégées du pipeline (GET /api/stats) :
 * - offres trouvées aujourd'hui / cette semaine ;
 * - nombre de doublons rencontrés ;
 * - répartition des offres par source (avec logo local) ;
 * - historique des derniers runs (table `runs`).
 *
 * Aucune dépendance de graphes : les barres de répartition sont de simples
 * <div> dimensionnées en pourcentage. Toute la mise en forme est inline pour
 * rester confinée à cette lane (aucune feuille de style partagée à modifier).
 *
 * Données chargées via le client API typé (`web/lib/api-client.ts`), qui
 * fonctionne aussi en mode MOCK (VITE_MOCK=1) tant que le backend n'existe pas.
 */
import { useEffect, useState } from "react";
import type { Run, Stats as StatsData } from "../../src/shared/types";
import { apiClient } from "../lib/api-client";

/* ------------------------------------------------------------------ */
/* Aides de formatage (déterministes, pures)                          */
/* ------------------------------------------------------------------ */

/** Formate une durée en millisecondes vers un libellé court (« 41,2 s »). */
function formatDuree(durationMs: number | null): string {
  if (durationMs == null) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  const secondes = durationMs / 1000;
  if (secondes < 60) {
    return `${secondes.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  }
  const minutes = Math.floor(secondes / 60);
  const reste = Math.round(secondes % 60);
  return `${minutes} min ${reste.toString().padStart(2, "0")} s`;
}

/** Formate une date ISO en date + heure locales lisibles. */
function formatDateHeure(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Résumé textuel des offres par source d'un run (« wttj 30, hellowork 20 »). */
function resumePerSource(perSource: Run["perSource"]): string {
  const entrees = Object.entries(perSource);
  if (entrees.length === 0) return "—";
  return entrees.map(([source, count]) => `${source} ${count}`).join(", ");
}

/* ------------------------------------------------------------------ */
/* Styles inline confinés à la lane                                   */
/* ------------------------------------------------------------------ */

const styles = {
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "1.75rem",
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "1rem",
  },
  card: {
    border: "1px solid #e2e2e2",
    borderRadius: "8px",
    padding: "1rem 1.25rem",
    background: "#fafafa",
  },
  cardValue: {
    fontSize: "2rem",
    fontWeight: 700,
    lineHeight: 1.1,
  },
  cardLabel: {
    marginTop: "0.35rem",
    color: "#555",
    fontSize: "0.9rem",
  },
  blockTitle: {
    margin: "0 0 0.75rem",
    fontSize: "1.05rem",
  },
  sourceRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    marginBottom: "0.55rem",
  },
  sourceLogo: {
    width: "20px",
    height: "20px",
    objectFit: "contain",
    flex: "0 0 auto",
  },
  sourceName: {
    width: "110px",
    flex: "0 0 auto",
    fontSize: "0.9rem",
  },
  barTrack: {
    flex: "1 1 auto",
    height: "14px",
    background: "#ececec",
    borderRadius: "7px",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    background: "#4f7cff",
    borderRadius: "7px",
  },
  sourceCount: {
    width: "44px",
    flex: "0 0 auto",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    fontSize: "0.9rem",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.9rem",
  },
  th: {
    textAlign: "left",
    borderBottom: "2px solid #ddd",
    padding: "0.5rem 0.6rem",
    color: "#555",
    fontWeight: 600,
  },
  td: {
    borderBottom: "1px solid #eee",
    padding: "0.5rem 0.6rem",
    verticalAlign: "top",
  },
  tdNum: {
    fontVariantNumeric: "tabular-nums",
    textAlign: "right" as const,
  },
  empty: {
    color: "#777",
    fontStyle: "italic",
  },
  state: {
    color: "#555",
  },
  error: {
    color: "#b00020",
  },
} as const;

/* ------------------------------------------------------------------ */
/* Sous-composants                                                    */
/* ------------------------------------------------------------------ */

/** Carte de chiffre clé (aujourd'hui / semaine / doublons). */
function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardValue}>{value.toLocaleString("fr-FR")}</div>
      <div style={styles.cardLabel}>{label}</div>
    </div>
  );
}

/** Répartition des offres par source, sous forme de barres horizontales. */
function RepartitionParSource({ bySource }: { bySource: StatsData["bySource"] }) {
  if (bySource.length === 0) {
    return <p style={styles.empty}>Aucune offre enregistrée pour le moment.</p>;
  }
  // Échelle relative au max pour des barres comparables.
  const max = Math.max(...bySource.map((s) => s.count), 1);
  return (
    <div>
      {bySource.map((s) => {
        const pourcentage = Math.round((s.count / max) * 100);
        return (
          <div key={s.source} style={styles.sourceRow}>
            <img
              src={s.logo}
              alt=""
              style={styles.sourceLogo}
              // Si le logo manque, on masque l'image sans casser la ligne.
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
            <span style={styles.sourceName}>{s.source}</span>
            <span
              style={styles.barTrack}
              role="img"
              aria-label={`${s.source} : ${s.count} offres`}
            >
              <span style={{ ...styles.barFill, width: `${pourcentage}%` }} />
            </span>
            <span style={styles.sourceCount}>{s.count.toLocaleString("fr-FR")}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Historique des derniers runs sous forme de table. */
function DerniersRuns({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return <p style={styles.empty}>Aucun run enregistré pour le moment.</p>;
  }
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Date</th>
          <th style={{ ...styles.th, textAlign: "right" }}>Durée</th>
          <th style={{ ...styles.th, textAlign: "right" }}>Trouvées</th>
          <th style={{ ...styles.th, textAlign: "right" }}>Nouvelles</th>
          <th style={{ ...styles.th, textAlign: "right" }}>Doublons</th>
          <th style={styles.th}>Par source</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td style={styles.td}>{formatDateHeure(run.startedAt)}</td>
            <td style={{ ...styles.td, ...styles.tdNum }}>{formatDuree(run.durationMs)}</td>
            <td style={{ ...styles.td, ...styles.tdNum }}>{run.found.toLocaleString("fr-FR")}</td>
            <td style={{ ...styles.td, ...styles.tdNum }}>{run.new.toLocaleString("fr-FR")}</td>
            <td style={{ ...styles.td, ...styles.tdNum }}>{run.duplicates.toLocaleString("fr-FR")}</td>
            <td style={styles.td}>{resumePerSource(run.perSource)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

type Etat =
  | { statut: "chargement" }
  | { statut: "erreur"; message: string }
  | { statut: "prêt"; data: StatsData };

export default function Stats() {
  const [etat, setEtat] = useState<Etat>({ statut: "chargement" });

  useEffect(() => {
    let actif = true;
    setEtat({ statut: "chargement" });
    apiClient
      .getStats()
      .then((data) => {
        if (actif) setEtat({ statut: "prêt", data });
      })
      .catch((err: unknown) => {
        if (!actif) return;
        const message = err instanceof Error ? err.message : "Erreur inconnue";
        setEtat({ statut: "erreur", message });
      });
    return () => {
      actif = false;
    };
  }, []);

  if (etat.statut === "chargement") {
    return (
      <section aria-label="Statistiques" aria-busy="true">
        <p style={styles.state}>Chargement des statistiques…</p>
      </section>
    );
  }

  if (etat.statut === "erreur") {
    return (
      <section aria-label="Statistiques">
        <p style={styles.error}>
          Impossible de charger les statistiques : {etat.message}
        </p>
      </section>
    );
  }

  const { today, week, duplicates, bySource, lastRuns } = etat.data;

  return (
    <section aria-label="Statistiques" style={styles.section}>
      <div style={styles.cards}>
        <StatCard value={today} label="Offres trouvées aujourd'hui" />
        <StatCard value={week} label="Offres trouvées cette semaine" />
        <StatCard value={duplicates} label="Doublons rencontrés" />
      </div>

      <div>
        <h2 style={styles.blockTitle}>Répartition par source</h2>
        <RepartitionParSource bySource={bySource} />
      </div>

      <div>
        <h2 style={styles.blockTitle}>Derniers runs</h2>
        <DerniersRuns runs={lastRuns} />
      </div>
    </section>
  );
}
