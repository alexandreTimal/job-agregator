/**
 * Bouton « Lancer la recherche » + barre de progression live (lane Offres).
 *
 * Déclenche un run du pipeline via `apiClient.startRun()` :
 * - si un run est déjà en cours côté serveur (HTTP 423), affiche un message et
 *   ne s'abonne pas une seconde fois ;
 * - sinon ouvre le flux SSE `apiClient.streamRun(...)` pour afficher l'avancement
 *   en direct, puis appelle `onRunFinished` à la fin (event `done` ou `error`).
 *
 * Pendant un run le bouton reste cliquable : au survol/focus il bascule en
 * « Annuler la recherche » (style danger) et déclenche `apiClient.cancelRun()`.
 * L'annulation revient par le flux SSE comme un terminal `done` neutre
 * (« Recherche annulée »), ce qui réarme le bouton via le chemin habituel.
 *
 * Garde-fou : si le flux SSE tombe sans émettre `done`/`error` (process tué,
 * serveur crashé), `apiClient.streamRun` ferme l'EventSource sans remonter
 * d'événement (cf. lane foundation : `es.onerror = () => es.close()`). Sans
 * filet, le bouton resterait bloqué sur « Recherche en cours… » indéfiniment.
 * Un chien de garde réarme donc le bouton après une période de silence prolongée.
 * (Correctif idéal côté foundation : émettre un RunEvent `error` sur `es.onerror`.)
 */
import { useEffect, useRef, useState } from "react";
import { Radar, Loader2, TriangleAlert, Ban } from "lucide-react";
import type { RunEvent } from "../../../src/shared/types";
import { apiClient } from "../../lib/api-client";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface RunButtonProps {
  /** Appelé quand le run se termine (succès ou erreur) pour rafraîchir la liste. */
  onRunFinished: () => void;
}

/**
 * Délai de silence (ms) au-delà duquel on considère le flux SSE perdu si aucun
 * événement n'arrive (ni `progress`, ni `done`, ni `error`). Généreux à dessein :
 * un run normal émet des `progress` réguliers bien avant ce seuil.
 */
const DELAI_SILENCE_MS = 120_000;

/**
 * Délai de silence (ms) raccourci pendant une annulation : une fois `cancelRun`
 * accepté, le serveur escalade en SIGKILL après ~5 s, donc le terminal `done`
 * « Recherche annulée » doit arriver vite. Au-delà, on considère le suivi perdu
 * sans attendre les 2 min du seuil nominal.
 */
const DELAI_ANNULATION_MS = 15_000;

export default function RunButton({ onRunFinished }: RunButtonProps) {
  const [enCours, setEnCours] = useState(false);
  /** Survol ou focus du bouton : déclenche l'affordance d'annulation en run. */
  const [survol, setSurvol] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  /** Compteur global d'avancement : sources terminées / total (phase `start`/`source-done`). */
  const [progression, setProgression] = useState<{ done: number; total: number } | null>(null);
  /** Fonction de fermeture du flux SSE courant, le cas échéant. */
  const fermerStreamRef = useRef<(() => void) | null>(null);
  /** Minuterie du chien de garde de silence SSE. */
  const minuterieSilenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function annulerChienDeGarde() {
    if (minuterieSilenceRef.current !== null) {
      clearTimeout(minuterieSilenceRef.current);
      minuterieSilenceRef.current = null;
    }
  }

  // Ferme proprement le flux SSE et le chien de garde si le composant est
  // démonté en plein run.
  useEffect(() => {
    return () => {
      annulerChienDeGarde();
      fermerStreamRef.current?.();
    };
  }, []);

  function arreterStream() {
    annulerChienDeGarde();
    fermerStreamRef.current?.();
    fermerStreamRef.current = null;
  }

  /**
   * (Ré)arme le chien de garde : si aucun événement n'arrive pendant
   * `DELAI_SILENCE_MS`, on suppose le flux perdu, on réarme le bouton et on
   * rafraîchit la liste (le run a pu aboutir côté serveur malgré la coupure).
   */
  function reactiverChienDeGarde(delai: number = DELAI_SILENCE_MS) {
    annulerChienDeGarde();
    minuterieSilenceRef.current = setTimeout(() => {
      minuterieSilenceRef.current = null;
      setErreur(
        "Suivi de la recherche interrompu (flux perdu). Rafraîchissez pour voir les résultats.",
      );
      setMessage(null);
      setEnCours(false);
      arreterStream();
      onRunFinished();
    }, delai);
  }

  function gererEvenement(event: RunEvent) {
    // Tout événement reçu prouve que le flux est vivant : on réarme le garde-fou.
    reactiverChienDeGarde();

    if (event.type === "progress") {
      // Compteur global mis à jour quand l'event le porte (start / source-done).
      if (typeof event.totalSources === "number") {
        setProgression({ done: event.sourcesDone ?? 0, total: event.totalSources });
      }

      switch (event.phase) {
        case "start":
          setMessage(
            `Lancement — ${event.totalSources ?? 0} source(s), ${event.totalTerms ?? 0} terme(s)`,
          );
          return;
        case "source-start":
          setMessage(`${event.source ?? "source"} — démarrage…`);
          return;
        case "source-progress": {
          const pos =
            typeof event.termIndex === "number" && typeof event.totalTerms === "number"
              ? ` (${event.termIndex}/${event.totalTerms})`
              : "";
          setMessage(`${event.source ?? "source"} — terme « ${event.term ?? "…"} »${pos}`);
          return;
        }
        case "source-done":
          setMessage(`${event.source ?? "source"} : ${event.found ?? 0} offre(s)`);
          return;
        default: {
          // Repli (event `progress` sans `phase` : compat ascendante).
          const morceaux = [
            event.term ? `terme « ${event.term} »` : null,
            event.source ? `source ${event.source}` : null,
            typeof event.found === "number" ? `${event.found} offre(s)` : null,
          ].filter(Boolean);
          setMessage(morceaux.length > 0 ? morceaux.join(" — ") : "recherche en cours…");
          return;
        }
      }
    }

    if (event.type === "done") {
      setMessage(event.message ?? "Recherche terminée.");
      setProgression(null);
      setEnCours(false);
      arreterStream();
      onRunFinished();
      return;
    }

    // type === "error"
    setErreur(event.message ?? "La recherche a échoué.");
    setMessage(null);
    setProgression(null);
    setEnCours(false);
    arreterStream();
    onRunFinished();
  }

  async function lancer() {
    if (enCours) return;
    setErreur(null);
    setProgression(null);
    setMessage("Démarrage…");
    setEnCours(true);

    let demarre: boolean;
    try {
      demarre = await apiClient.startRun();
    } catch (e) {
      setEnCours(false);
      setMessage(null);
      setErreur(e instanceof Error ? e.message : "Impossible de lancer la recherche.");
      return;
    }

    if (!demarre) {
      // HTTP 423 : un run est déjà en cours côté serveur.
      setEnCours(false);
      setMessage(null);
      setErreur("Une recherche est déjà en cours.");
      return;
    }

    fermerStreamRef.current = apiClient.streamRun(gererEvenement);
    // Arme le garde-fou dès l'ouverture : couvre le cas d'une coupure du flux
    // avant tout premier événement.
    reactiverChienDeGarde();
  }

  async function annuler() {
    if (!enCours) return;
    setErreur(null);
    // Le compteur de progression n'a plus de sens pendant l'annulation : on le
    // retire pour ne pas laisser un badge `k/N` périmé à côté de « Annulation… ».
    setProgression(null);
    setMessage("Annulation…");

    let annule: boolean;
    try {
      annule = await apiClient.cancelRun();
    } catch {
      // L'appel a échoué : le run suit son cours, on en informe sans réarmer.
      setMessage("Échec de l'annulation. La recherche continue.");
      return;
    }

    if (!annule) {
      // HTTP 409 : plus aucun run côté serveur (course). On réarme localement.
      setEnCours(false);
      setMessage(null);
      arreterStream();
      onRunFinished();
      return;
    }
    // 202 : le terminal `done` « Recherche annulée » arrivera par le flux SSE et
    // réarmera le bouton via `gererEvenement`. On raccourcit le chien de garde :
    // l'escalade SIGKILL serveur garantit un retour rapide ; au-delà, on ne veut
    // pas laisser le bouton coincé sur « Annulation… » pendant 2 min.
    reactiverChienDeGarde(DELAI_ANNULATION_MS);
  }

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-panel)]/60 shadow-[var(--shadow-panel)]">
      {/* Texture grille en fond du panneau de commande */}
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-[0.35]" aria-hidden />

      <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              "grid size-12 place-items-center rounded-[var(--radius-md)] border transition-colors",
              enCours
                ? "border-[var(--color-signal)]/40 bg-[var(--color-signal)]/10 text-[var(--color-signal)]"
                : "border-[var(--color-line-strong)] bg-black/30 text-[var(--color-ink-soft)]",
            )}
          >
            <Radar aria-hidden="true" className={cn("size-5", enCours && "[animation:pulse-dot_1.8s_ease-in-out_infinite]")} />
          </div>
          <div>
            <p className="font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-[0.18em] text-[var(--color-ink-mute)]">
              Pipeline
            </p>
            <p className="text-[0.98rem] font-semibold text-[var(--color-ink)]">
              {enCours ? "Collecte en cours" : "Lancer une collecte"}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={enCours ? annuler : lancer}
          onMouseEnter={() => setSurvol(true)}
          onMouseLeave={() => setSurvol(false)}
          onFocus={() => setSurvol(true)}
          onBlur={() => setSurvol(false)}
          aria-busy={enCours && !survol}
          className={cn(
            "inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] px-5 text-sm font-semibold " +
              "transition-all duration-200 ease-[var(--ease-out-expo)] active:translate-y-px",
            !enCours
              ? "cursor-pointer bg-[var(--color-signal)] text-[#0a0b0a] shadow-[0_10px_30px_-12px_var(--color-signal-glow)] hover:bg-[#d4fa60]"
              : survol
                ? "cursor-pointer border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                : "cursor-progress border border-[var(--color-line-strong)] bg-black/30 text-[var(--color-ink-mute)]",
          )}
        >
          {!enCours ? (
            <>
              <Radar aria-hidden="true" className="size-4" />
              Lancer la recherche
            </>
          ) : survol ? (
            <>
              <Ban aria-hidden="true" className="size-4" />
              Annuler la recherche
            </>
          ) : (
            <>
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              Recherche en cours…
            </>
          )}
        </button>
      </div>

      {/* Faisceau de balayage (progression indéterminée). Purement décoratif :
          l'avancement réel est annoncé par la ligne de statut (role="status"). */}
      {enCours && (
        <div aria-hidden="true" className="relative h-[3px] w-full overflow-hidden bg-black/40">
          <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-[var(--color-signal)] to-transparent [animation:scan_1.4s_linear_infinite]" />
        </div>
      )}

      {/* Ligne de statut / erreur */}
      {(message || erreur) && (
        <div className="relative border-t border-[var(--color-line)] px-5 py-3 sm:px-6">
          {message && !erreur && (
            <p
              className="flex items-center gap-2 font-[family-name:var(--font-mono)] text-[0.78rem] text-[var(--color-ink-soft)]"
              role="status"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-signal)] [animation:pulse-dot_1.6s_ease-in-out_infinite]" />
              {progression && progression.total > 0 && (
                <Badge tone="mono" className="shrink-0 tabular-nums">
                  {progression.done}/{progression.total}
                </Badge>
              )}
              <span className="truncate">{message}</span>
            </p>
          )}
          {erreur && (
            <p
              className="flex items-center gap-2 text-[0.82rem] text-[var(--color-danger)]"
              role="alert"
            >
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
              {erreur}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
