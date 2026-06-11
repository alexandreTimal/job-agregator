/**
 * Carte d'une offre dans la liste (lane Offres).
 *
 * Affiche le titre (lien vers l'offre), le logo de la source, l'entreprise/lieu
 * et l'ancienneté (`publishedAt ?? firstSeenAt` rendue en « il y a X »).
 * Expose deux actions : Liker (bascule favori) et Supprimer (soft-delete).
 *
 * Composant purement présentationnel : il ne fait aucun appel réseau, il
 * remonte les intentions à la page via `onToggleLike` / `onDelete`.
 */
import { useEffect, useState } from "react";
import type { Offer } from "../../../src/shared/types";
import { ancienneteRelative } from "./relative-time";

interface OfferCardProps {
  offre: Offer;
  /** True pendant qu'une action (like/delete) est en cours sur cette offre. */
  enCours: boolean;
  onToggleLike: (offre: Offer) => void;
  onDelete: (offre: Offer) => void;
}

/** Logo local de la source (assets public/logos/{source}.svg). */
function logoSource(source: string): string {
  return `/logos/${source}.svg`;
}

export default function OfferCard({ offre, enCours, onToggleLike, onDelete }: OfferCardProps) {
  const date = offre.publishedAt ?? offre.firstSeenAt;
  /** True si le logo de la source n'a pas pu être chargé (asset manquant). */
  const [logoCasse, setLogoCasse] = useState(false);

  // L'élément <img> est réutilisé par React (key={offre.id}) si la source change ;
  // on réinitialise alors l'état « cassé » pour retenter le chargement du nouveau logo.
  useEffect(() => {
    setLogoCasse(false);
  }, [offre.source]);

  return (
    <article className={`offer-card${offre.liked ? " offer-card--liked" : ""}`}>
      {!logoCasse && (
        <img
          className="offer-card__logo"
          src={logoSource(offre.source)}
          alt={`Logo ${offre.source}`}
          width={32}
          height={32}
          loading="lazy"
          /* Si le logo manque, on masque l'image cassée sans bruit, via l'état React. */
          onError={() => setLogoCasse(true)}
        />
      )}

      <div className="offer-card__body">
        <h3 className="offer-card__title">
          <a href={offre.url} target="_blank" rel="noopener noreferrer">
            {offre.title}
          </a>
        </h3>
        <p className="offer-card__meta">
          {offre.company && <span className="offer-card__company">{offre.company}</span>}
          {offre.location && <span className="offer-card__location">{offre.location}</span>}
          <span className="offer-card__source">{offre.source}</span>
        </p>
        <p className="offer-card__age">
          <time dateTime={date}>{ancienneteRelative(date)}</time>
        </p>
      </div>

      <div className="offer-card__actions">
        <button
          type="button"
          className="offer-card__like"
          aria-pressed={offre.liked}
          disabled={enCours}
          title={offre.liked ? "Retirer des favoris" : "Ajouter aux favoris"}
          onClick={() => onToggleLike(offre)}
        >
          {offre.liked ? "★ Favori" : "☆ Liker"}
        </button>
        <button
          type="button"
          className="offer-card__delete"
          disabled={enCours}
          title="Supprimer cette offre"
          onClick={() => onDelete(offre)}
        >
          Supprimer
        </button>
      </div>
    </article>
  );
}
