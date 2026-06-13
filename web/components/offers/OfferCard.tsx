/**
 * Carte d'une offre (lane Offres) — version control-room.
 *
 * Présentationnel : remonte les intentions via `onToggleLike` / `onToggleApplied`
 * / `onDelete`, et expose un panneau « candidature » (CV adapté + lettre générés
 * localement) ouvert/fermé localement, alimenté par le parent (hook useCandidatures).
 * Affiche logo de source (repli monogramme), titre cliquable, méta et ancienneté.
 */
import { useEffect, useState } from "react";
import {
  Heart, Trash2, ArrowUpRight, MapPin, Building2, Send, CalendarClock, FileText, Loader2,
} from "lucide-react";
import type { CandidatureState, Offer } from "../../../src/shared/types";
import { ancienneteRelative, formatDateRelance } from "./relative-time";
import { Badge } from "@/components/ui/badge";
import CandidaturePanel from "./CandidaturePanel";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface OfferCardProps {
  offre: Offer;
  /** True pendant qu'une action (like/applied/delete) est en cours sur cette offre. */
  enCours: boolean;
  onToggleLike: (offre: Offer) => void;
  onToggleApplied: (offre: Offer) => void;
  onDelete: (offre: Offer) => void;
  /** État de la candidature de cette offre (CV + lettre), ou undefined si inconnu. */
  candidature?: CandidatureState;
  /** Appelé à l'ouverture du panneau, pour charger l'état si encore inconnu. */
  onOpenCandidature: (offre: Offer) => void;
  /** Lance/relance la génération de la candidature (consigne optionnelle). */
  onGenerateCandidature: (offre: Offer, instruction?: string) => void;
}

function logoSource(source: string): string {
  return `/logos/${source}.svg`;
}

export default function OfferCard({
  offre,
  enCours,
  onToggleLike,
  onToggleApplied,
  onDelete,
  candidature,
  onOpenCandidature,
  onGenerateCandidature,
}: OfferCardProps) {
  const date = offre.publishedAt ?? offre.firstSeenAt;
  const postule = offre.appliedAt !== null;
  const [logoCasse, setLogoCasse] = useState(false);
  const [panneauOuvert, setPanneauOuvert] = useState(false);

  useEffect(() => {
    setLogoCasse(false);
  }, [offre.source]);

  const candStatus = candidature?.status ?? "none";

  function basculerPanneau() {
    const ouvrir = !panneauOuvert;
    setPanneauOuvert(ouvrir);
    if (ouvrir) onOpenCandidature(offre); // charge l'état au premier déploiement
  }

  return (
    <article
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-[var(--radius-md)] border p-4 pl-5",
        "transition-all duration-300 ease-[var(--ease-out-expo)]",
        offre.liked
          ? "border-[var(--color-amber)]/35 bg-[var(--color-amber)]/[0.04]"
          : "border-[var(--color-line)] bg-[var(--color-panel)]/55 hover:border-[var(--color-line-strong)] hover:bg-[var(--color-panel-2)]/70",
      )}
    >
      {/* Rail gauche : favori (ambre) sinon survol (signal) */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-0 h-full w-[3px] transition-all duration-300",
          offre.liked
            ? "bg-[var(--color-amber)]"
            : "bg-[var(--color-signal)] opacity-0 group-hover:opacity-70",
        )}
      />

      {/* Rangée principale : logo · corps · actions */}
      <div className="flex items-stretch gap-4">
        {/* Logo / monogramme de source */}
        <div className="flex shrink-0 items-start pt-0.5">
          <div className="grid size-11 place-items-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-black/30">
            {logoCasse ? (
              <span
                aria-hidden="true"
                className="font-[family-name:var(--font-mono)] text-sm font-semibold uppercase text-[var(--color-ink-mute)]"
              >
                {offre.source.slice(0, 2)}
              </span>
            ) : (
              <img
                className="size-7 object-contain"
                src={logoSource(offre.source)}
                alt=""
                width={28}
                height={28}
                loading="lazy"
                onError={() => setLogoCasse(true)}
              />
            )}
          </div>
        </div>

        {/* Corps */}
        <div className="min-w-0 flex-1">
          <h3 className="pr-2 text-[0.98rem] font-semibold leading-snug">
            <a
              href={offre.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-baseline gap-1 text-[var(--color-ink)] transition-colors hover:text-[var(--color-signal)]"
            >
              <span className="text-balance">{offre.title}</span>
              <ArrowUpRight
                aria-hidden="true"
                className="size-3.5 shrink-0 self-center text-[var(--color-ink-faint)] transition-colors group-hover:text-[var(--color-signal)]"
              />
              <span className="sr-only"> (ouvre l'offre dans un nouvel onglet)</span>
            </a>
          </h3>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.82rem] text-[var(--color-ink-soft)]">
            {offre.company && (
              <span className="inline-flex items-center gap-1.5">
                <Building2 aria-hidden="true" className="size-3.5 text-[var(--color-ink-faint)]" />
                {offre.company}
              </span>
            )}
            {offre.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin aria-hidden="true" className="size-3.5 text-[var(--color-ink-faint)]" />
                {offre.location}
              </span>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <span className="font-[family-name:var(--font-mono)] text-[0.72rem] uppercase tracking-wide text-[var(--color-ink-mute)]">
              {offre.source}
            </span>
            <span aria-hidden="true" className="size-1 rounded-full bg-[var(--color-line-strong)]" />
            <time
              dateTime={date}
              className="font-[family-name:var(--font-mono)] text-[0.72rem] text-[var(--color-ink-mute)]"
            >
              {ancienneteRelative(date)}
            </time>
            {candStatus !== "none" && (
              <Badge tone={candStatus === "ready" ? "signal" : "mono"}>
                {candStatus === "generating" || candStatus === "queued" ? (
                  <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                ) : (
                  <FileText aria-hidden="true" className="size-3" />
                )}
                <span className={cn(candStatus === "failed" && "text-[var(--color-danger)]")}>
                  {candStatus === "ready"
                    ? "Candidature prête"
                    : candStatus === "failed"
                      ? "Candidature échouée"
                      : "Candidature en cours"}
                </span>
              </Badge>
            )}
          </div>

          {postule && offre.followUpAt && (
            <div className="mt-2.5">
              <Badge tone="signal">
                <CalendarClock aria-hidden="true" className="size-3.5" />
                <span>
                  Relance le{" "}
                  <span className="font-[family-name:var(--font-mono)]">
                    {formatDateRelance(offre.followUpAt)}
                  </span>
                </span>
              </Badge>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-col items-end justify-center gap-1.5">
          <button
            type="button"
            aria-expanded={panneauOuvert}
            aria-label={panneauOuvert ? "Fermer la candidature" : "Préparer la candidature (CV + lettre)"}
            title="Candidature (CV + lettre)"
            onClick={basculerPanneau}
            className={cn(
              "grid size-9 place-items-center rounded-[var(--radius-xs)] border transition-all duration-200",
              panneauOuvert || candStatus === "ready"
                ? "border-[var(--color-signal)]/40 bg-[var(--color-signal)]/15 text-[var(--color-signal)]"
                : "border-[var(--color-line)] text-[var(--color-ink-mute)] hover:border-[var(--color-signal)]/40 hover:text-[var(--color-signal)]",
            )}
          >
            <FileText aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            aria-pressed={offre.liked}
            aria-label={offre.liked ? "Retirer des favoris" : "Ajouter aux favoris"}
            disabled={enCours}
            onClick={() => onToggleLike(offre)}
            className={cn(
              "grid size-9 place-items-center rounded-[var(--radius-xs)] border transition-all duration-200",
              "disabled:cursor-progress disabled:opacity-40",
              offre.liked
                ? "border-[var(--color-amber)]/40 bg-[var(--color-amber)]/15 text-[var(--color-amber)]"
                : "border-[var(--color-line)] text-[var(--color-ink-mute)] hover:border-[var(--color-amber)]/40 hover:text-[var(--color-amber)]",
            )}
          >
            <Heart aria-hidden="true" className={cn("size-4", offre.liked && "fill-current")} />
          </button>
          <button
            type="button"
            aria-pressed={postule}
            aria-label={postule ? "Annuler « postulée »" : "Marquer comme postulée"}
            title={postule ? "Annuler « postulée »" : "J'ai postulé"}
            disabled={enCours}
            onClick={() => onToggleApplied(offre)}
            className={cn(
              "grid size-9 place-items-center rounded-[var(--radius-xs)] border transition-all duration-200",
              "disabled:cursor-progress disabled:opacity-40",
              postule
                ? "border-[var(--color-signal)]/40 bg-[var(--color-signal)]/15 text-[var(--color-signal)]"
                : "border-[var(--color-line)] text-[var(--color-ink-mute)] hover:border-[var(--color-signal)]/40 hover:text-[var(--color-signal)]",
            )}
          >
            <Send aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Supprimer cette offre"
            disabled={enCours}
            onClick={() => onDelete(offre)}
            className={cn(
              "grid size-9 place-items-center rounded-[var(--radius-xs)] border border-[var(--color-line)] text-[var(--color-ink-mute)] transition-all duration-200",
              "hover:border-[var(--color-danger)]/40 hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)]",
              "disabled:cursor-progress disabled:opacity-40",
            )}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      {/* Panneau candidature (CV + lettre), déplié sous la rangée */}
      {panneauOuvert && (
        <CandidaturePanel
          state={candidature}
          onGenerate={(instruction) => onGenerateCandidature(offre, instruction)}
          cvUrl={apiClient.candidatureCvUrl(offre.id)}
          lettreUrl={apiClient.candidatureLettreUrl(offre.id)}
        />
      )}
    </article>
  );
}
