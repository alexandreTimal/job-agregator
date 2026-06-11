/**
 * Page Stats.
 *
 * Affiche les statistiques agrégées du pipeline (GET /api/stats) :
 * - offres trouvées aujourd'hui / cette semaine ;
 * - nombre de doublons rencontrés ;
 * - répartition des offres par source (avec logo local) ;
 * - historique des derniers runs (table `runs`).
 *
 * Données chargées via le client API typé (`web/lib/api-client.ts`).
 */
import { useEffect, useState } from "react";
import { CalendarDays, CalendarRange, CopyX, Timer, Search, Sparkles } from "lucide-react";
import type { Run, Stats as StatsData, SourceCount } from "../../src/shared/types";
import { apiClient } from "../lib/api-client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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

/**
 * Formate une date en date + heure locales lisibles.
 *
 * Robustesse : le backend peut renvoyer un format non strictement ISO
 * (« 2026-06-11 12:35:08 », sans T ni Z), que certains navigateurs parsent en
 * NaN ou interprètent diversement (UTC vs local). On extrait donc les champs à
 * la main quand le format le permet, avec repli sur `new Date`.
 *
 * `started_at` est stocké en UTC (cf. `insertRun`) sans suffixe de fuseau : on
 * construit la date via `Date.UTC` (et non `new Date(année, mois…)` qui aurait
 * interprété ces composants comme l'heure LOCALE et perdu le décalage). Le rendu
 * `toLocaleString` reconvertit ensuite vers le fuseau du navigateur.
 */
function formatDateHeure(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  const date = m
    ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0))
    : new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ------------------------------------------------------------------ */
/* Sous-composants                                                    */
/* ------------------------------------------------------------------ */

/** Carte de chiffre-clé : grand nombre serif + libellé mono + icône. */
function StatCard({
  value,
  label,
  icon,
  accent,
  i,
}: {
  value: number;
  label: string;
  icon: React.ReactNode;
  accent: "signal" | "amber" | "mute";
  i: number;
}) {
  const tone =
    accent === "signal"
      ? "text-[var(--color-signal)]"
      : accent === "amber"
        ? "text-[var(--color-amber)]"
        : "text-[var(--color-ink-soft)]";
  return (
    <Card
      role="group"
      aria-label={`${label} : ${value.toLocaleString("fr-FR")}`}
      style={{ "--i": i } as React.CSSProperties}
      className="relative overflow-hidden p-5"
    >
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-20" aria-hidden="true" />
      {/* Contenu visuel ignoré du lecteur d'écran : l'aria-label du groupe le résume. */}
      <div aria-hidden="true" className="relative flex items-start justify-between">
        <span
          className={cn(
            "grid size-9 place-items-center rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-black/30 [&_svg]:size-[1.05rem]",
            tone,
          )}
        >
          {icon}
        </span>
      </div>
      <div aria-hidden="true" className="relative mt-5">
        <div className={cn("font-[family-name:var(--font-serif)] text-[3rem] leading-none", tone)}>
          {value.toLocaleString("fr-FR")}
        </div>
        <div className="mt-2 font-[family-name:var(--font-mono)] text-[0.72rem] uppercase tracking-[0.12em] text-[var(--color-ink-mute)]">
          {label}
        </div>
      </div>
    </Card>
  );
}

/** Répartition des offres par source — barres animées + logo + monogramme de repli. */
function RepartitionParSource({ bySource }: { bySource: SourceCount[] }) {
  if (bySource.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-sm italic text-[var(--color-ink-mute)]">
        Aucune offre enregistrée pour le moment.
      </p>
    );
  }
  const max = Math.max(...bySource.map((s) => s.count), 1);
  const total = bySource.reduce((acc, s) => acc + s.count, 0);
  return (
    <div className="flex flex-col gap-4">
      {bySource.map((s, idx) => {
        const pourcentage = Math.round((s.count / max) * 100);
        const part = total > 0 ? Math.round((s.count / total) * 100) : 0;
        return (
          <div key={s.source} className="flex items-center gap-3.5">
            <SourceLogo source={s.source} logo={s.logo} />
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="truncate text-[0.85rem] font-medium text-[var(--color-ink-soft)]">
                  {s.source}
                </span>
                <span className="shrink-0 font-[family-name:var(--font-mono)] text-[0.75rem] text-[var(--color-ink-mute)]">
                  {s.count.toLocaleString("fr-FR")}
                  <span className="ml-1.5 text-[var(--color-ink-faint)]">{part}%</span>
                </span>
              </div>
              <span
                className="block h-2 overflow-hidden rounded-full bg-black/40"
                role="img"
                aria-label={`${s.source} : ${s.count} offre${s.count > 1 ? "s" : ""} (${part}% du total)`}
              >
                <span
                  aria-hidden="true"
                  className="block h-full origin-left rounded-full bg-gradient-to-r from-[var(--color-signal-dim)] to-[var(--color-signal)] [animation:grow-x_0.9s_var(--ease-out-expo)_both]"
                  style={{ width: `${pourcentage}%`, animationDelay: `${idx * 80 + 120}ms` }}
                />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Logo de source avec repli monogramme si l'asset manque. */
function SourceLogo({ source, logo }: { source: string; logo: string }) {
  const [casse, setCasse] = useState(false);
  return (
    <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-black/30">
      {casse ? (
        <span className="font-[family-name:var(--font-mono)] text-xs font-semibold uppercase text-[var(--color-ink-mute)]">
          {source.slice(0, 2)}
        </span>
      ) : (
        <img
          src={logo}
          alt=""
          width={22}
          height={22}
          className="size-[22px] object-contain"
          onError={() => setCasse(true)}
        />
      )}
    </div>
  );
}

/** Mini-statistique d'un run (libellé mono + valeur). */
function RunMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "signal" | "amber";
}) {
  return (
    <div className="flex flex-col">
      <span className="font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-wider text-[var(--color-ink-mute)]">
        {label}
      </span>
      <span
        className={cn(
          "font-[family-name:var(--font-mono)] text-[0.95rem] font-semibold",
          tone === "signal"
            ? "text-[var(--color-signal)]"
            : tone === "amber"
              ? "text-[var(--color-amber)]"
              : "text-[var(--color-ink)]",
        )}
      >
        {value.toLocaleString("fr-FR")}
      </span>
    </div>
  );
}

/** Historique des derniers runs sous forme de cartes empilées. */
function DerniersRuns({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-sm italic text-[var(--color-ink-mute)]">
        Aucun run enregistré pour le moment.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {runs.map((run) => {
        // Toutes les sources interrogées par le run, y compris celles à 0 (une
        // source peut avoir tourné sans rien rapporter) : on les montre grisées
        // pour qu'il soit visible qu'elles ont bien été frappées. Tri par volume
        // décroissant → les 0 en fin de liste.
        const sources = Object.entries(run.perSource).sort((a, b) => b[1] - a[1]);
        return (
          <div
            key={run.id}
            className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-black/15 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Timer className="size-4 text-[var(--color-ink-faint)]" />
                <span className="font-[family-name:var(--font-mono)] text-[0.8rem] text-[var(--color-ink-soft)]">
                  {formatDateHeure(run.startedAt)}
                </span>
                <Badge tone="mono">{formatDuree(run.durationMs)}</Badge>
              </div>
              <div className="flex items-center gap-5">
                <RunMetric label="Trouvées" value={run.found} />
                <RunMetric label="Nouvelles" value={run.new} tone="signal" />
                <RunMetric label="Doublons" value={run.duplicates} tone="amber" />
              </div>
            </div>
            {sources.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--color-line)] pt-3">
                {sources.map(([source, count]) => (
                  <Badge key={source} tone="neutral" className={cn(count === 0 && "opacity-55")}>
                    <span className="text-[var(--color-ink-faint)]">{source}</span>
                    <span
                      className={cn(
                        "font-[family-name:var(--font-mono)]",
                        count > 0
                          ? "text-[var(--color-ink-soft)]"
                          : "text-[var(--color-ink-faint)]",
                      )}
                    >
                      {count}
                    </span>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="mb-4 flex items-center gap-2.5 text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-mute)] [&_svg]:size-4 [&_svg]:text-[var(--color-ink-faint)]">
      {icon}
      {children}
    </h2>
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
      <section aria-label="Statistiques" aria-busy="true" className="flex flex-col gap-6">
        <span className="sr-only">Chargement des statistiques…</span>
        <div aria-hidden="true" className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[148px] animate-pulse rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-panel)]/40"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>
        <div aria-hidden="true" className="h-64 animate-pulse rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-panel)]/40" />
      </section>
    );
  }

  if (etat.statut === "erreur") {
    return (
      <section aria-label="Statistiques">
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
        >
          Impossible de charger les statistiques : {etat.message}
        </div>
      </section>
    );
  }

  const { today, week, duplicates, bySource, lastRuns } = etat.data;

  return (
    <section aria-label="Statistiques" className="flex flex-col gap-8">
      <div className="stagger grid gap-4 sm:grid-cols-3">
        <StatCard value={today} label="Trouvées aujourd'hui" icon={<CalendarDays />} accent="signal" i={0} />
        <StatCard value={week} label="Trouvées cette semaine" icon={<CalendarRange />} accent="mute" i={1} />
        <StatCard value={duplicates} label="Doublons rencontrés" icon={<CopyX />} accent="amber" i={2} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <Card className="animate-rise p-6">
          <SectionTitle icon={<Sparkles />}>Répartition par source</SectionTitle>
          <RepartitionParSource bySource={bySource} />
        </Card>

        <Card className="animate-rise p-6">
          <SectionTitle icon={<Search />}>Derniers runs</SectionTitle>
          <DerniersRuns runs={lastRuns} />
        </Card>
      </div>
    </section>
  );
}
