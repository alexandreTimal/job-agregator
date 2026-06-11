/**
 * Carte d'une offre (lane Offres) — version control-room.
 *
 * Présentationnel pur : aucun appel réseau, remonte les intentions via
 * `onToggleLike` / `onDelete`. Affiche logo de source (avec repli monogramme),
 * titre cliquable, méta (entreprise/lieu) et ancienneté. Le rail gauche s'allume
 * au survol (signal) ou en favori (ambre).
 */
import { useEffect, useState } from "react";
import { Heart, Trash2, ArrowUpRight, MapPin, Building2 } from "lucide-react";
import type { Offer } from "../../../src/shared/types";
import { ancienneteRelative } from "./relative-time";
import { cn } from "@/lib/utils";

interface OfferCardProps {
  offre: Offer;
  /** True pendant qu'une action (like/delete) est en cours sur cette offre. */
  enCours: boolean;
  onToggleLike: (offre: Offer) => void;
  onDelete: (offre: Offer) => void;
}

function logoSource(source: string): string {
  return `/logos/${source}.svg`;
}

export default function OfferCard({ offre, enCours, onToggleLike, onDelete }: OfferCardProps) {
  const date = offre.publishedAt ?? offre.firstSeenAt;
  const [logoCasse, setLogoCasse] = useState(false);

  useEffect(() => {
    setLogoCasse(false);
  }, [offre.source]);

  return (
    <article
      className={cn(
        "group relative flex items-stretch gap-4 overflow-hidden rounded-[var(--radius-md)] border p-4 pl-5",
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

        <div className="mt-2.5 flex items-center gap-3">
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
        </div>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 flex-col items-end justify-center gap-1.5">
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
    </article>
  );
}
