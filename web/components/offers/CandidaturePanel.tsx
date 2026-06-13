/**
 * Panneau « postuler » d'une offre (control-room) — présentationnel pur.
 *
 * Affiche l'état de la candidature (CV adapté + lettre, générés localement par un
 * agent) et expose les actions : générer/relancer, et les DEUX boutons d'ouverture
 * (PDF du CV / lettre), désactivés tant que les fichiers ne sont pas prêts.
 *
 * Aucun appel réseau ici : tout remonte via `onGenerate` ; l'état vient du parent
 * (hook `useCandidatures`). Plusieurs panneaux peuvent être actifs en parallèle.
 */
import { useState } from "react";
import { FileText, Mail, Sparkles, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import type { CandidatureState } from "../../../src/shared/types";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ancienneteRelative } from "./relative-time";
import { cn } from "@/lib/utils";

interface CandidaturePanelProps {
  state: CandidatureState | undefined;
  /** Lance/relance la génération (consigne optionnelle pour orienter la relance). */
  onGenerate: (instruction?: string) => void;
  cvUrl: string;
  lettreUrl: string;
}

const STATUS_TEXT: Record<CandidatureState["status"], string> = {
  none: "Pas encore générée",
  queued: "En file d'attente…",
  generating: "Génération en cours…",
  ready: "Candidature prête",
  failed: "Échec de la génération",
};

/** Lien d'ouverture d'un fichier (nouvel onglet), désactivé si pas prêt. */
function OpenLink({ ready, href, icon, label }: { ready: boolean; href: string; icon: React.ReactNode; label: string }) {
  const classes = cn(buttonVariants({ variant: "outline", size: "sm" }), "flex-1", !ready && "pointer-events-none opacity-45");
  if (!ready) {
    return (
      <span className={classes} aria-disabled="true">
        {icon}
        {label}
      </span>
    );
  }
  return (
    <a className={classes} href={href} target="_blank" rel="noopener noreferrer">
      {icon}
      {label}
      <span className="sr-only"> (nouvel onglet)</span>
    </a>
  );
}

export default function CandidaturePanel({ state, onGenerate, cvUrl, lettreUrl }: CandidaturePanelProps) {
  const status = state?.status ?? "none";
  const enCours = status === "queued" || status === "generating";
  const aResultat = status === "ready" || status === "failed";
  const [consigne, setConsigne] = useState("");

  return (
    <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-panel)]/40 p-3">
      {/* Ligne de statut + action de génération */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 font-[family-name:var(--font-mono)] text-[0.78rem]"
        >
          {status === "generating" ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-[var(--color-signal)]" />
          ) : status === "ready" ? (
            <span aria-hidden="true" className="size-2 rounded-full bg-[var(--color-signal)]" />
          ) : status === "failed" ? (
            <AlertTriangle aria-hidden="true" className="size-3.5 text-[var(--color-danger)]" />
          ) : status === "queued" ? (
            <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-[var(--color-amber)]" />
          ) : (
            <span aria-hidden="true" className="size-2 rounded-full bg-[var(--color-line-strong)]" />
          )}
          <span
            className={cn(
              status === "ready" && "text-[var(--color-signal)]",
              status === "failed" && "text-[var(--color-danger)]",
              (status === "none" || enCours) && "text-[var(--color-ink-soft)]",
            )}
          >
            {STATUS_TEXT[status]}
          </span>
          {status === "ready" && state?.generatedAt && (
            <span className="text-[var(--color-ink-mute)]">· {ancienneteRelative(state.generatedAt)}</span>
          )}
        </span>

        <button
          type="button"
          onClick={() => onGenerate(consigne.trim() || undefined)}
          disabled={enCours}
          className={cn(
            buttonVariants({ variant: aResultat ? "outline" : "signal", size: "sm" }),
            "disabled:cursor-progress",
          )}
        >
          {enCours ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : aResultat ? (
            <RefreshCw aria-hidden="true" className="size-4" />
          ) : (
            <Sparkles aria-hidden="true" className="size-4" />
          )}
          {enCours ? "Génération…" : aResultat ? "Régénérer" : "Générer la candidature"}
        </button>
      </div>

      {/* Erreur éventuelle */}
      {status === "failed" && state?.error && (
        <p role="alert" className="mt-2 text-[0.78rem] text-[var(--color-danger)]">
          {state.error}
        </p>
      )}

      {/* Les DEUX boutons d'ouverture */}
      <div className="mt-3 flex gap-2">
        <OpenLink
          ready={Boolean(state?.cvReady)}
          href={cvUrl}
          icon={<FileText aria-hidden="true" className="size-4" />}
          label="Ouvrir le CV (PDF)"
        />
        <OpenLink
          ready={Boolean(state?.lettreReady)}
          href={lettreUrl}
          icon={<Mail aria-hidden="true" className="size-4" />}
          label="Ouvrir la lettre"
        />
      </div>

      {/* Consigne de relance (optionnelle), proposée une fois un résultat obtenu */}
      {aResultat && (
        <div className="mt-3">
          <label htmlFor={`consigne-${state?.offerId}`} className="sr-only">
            Consigne pour orienter la relance
          </label>
          <Input
            id={`consigne-${state?.offerId}`}
            value={consigne}
            onChange={(e) => setConsigne(e.target.value)}
            placeholder="Consigne pour relancer (optionnel) — ex. « insiste plus sur le commercial »"
          />
        </div>
      )}
    </div>
  );
}
