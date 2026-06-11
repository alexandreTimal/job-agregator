/**
 * Page Offres.
 *
 * Liste les offres (`apiClient.getOffers(filter, sort)`), avec :
 * - un filtre Favoris (`all` | `liked`) et un tri (`recent` | `score`) ;
 * - sur chaque offre, les actions Liker (POST like) et Supprimer (soft-delete,
 *   retire l'offre de la liste localement) ;
 * - un bouton « Lancer la recherche » (RunButton) qui déclenche le run, suit la
 *   progression via SSE et rafraîchit la liste à la fin.
 *
 * Le tri/filtre côté serveur fait foi (les likées remontent toujours en tête,
 * cf. docs/api-contract.md) ; l'UI ne réordonne pas, elle ré-interroge l'API.
 */
import { useCallback, useEffect, useState } from "react";
import type { Offer, OfferFilter, OfferSort } from "../../src/shared/types";
import { apiClient } from "../lib/api-client";
import OfferCard from "../components/offers/OfferCard";
import RunButton from "../components/offers/RunButton";
import "../components/offers/offers.css";

type EtatChargement = "idle" | "loading" | "ready" | "error";

export default function Offers() {
  const [filtre, setFiltre] = useState<OfferFilter>("all");
  const [tri, setTri] = useState<OfferSort>("recent");
  const [offres, setOffres] = useState<Offer[]>([]);
  const [etat, setEtat] = useState<EtatChargement>("idle");
  const [erreur, setErreur] = useState<string | null>(null);
  /** Ids des offres dont une action (like/delete) est en cours, pour désactiver leurs boutons. */
  const [actionsEnCours, setActionsEnCours] = useState<Set<number>>(new Set());

  const charger = useCallback(async () => {
    setEtat("loading");
    setErreur(null);
    try {
      const liste = await apiClient.getOffers(filtre, tri);
      setOffres(liste);
      setEtat("ready");
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Échec du chargement des offres.");
      setEtat("error");
    }
  }, [filtre, tri]);

  useEffect(() => {
    void charger();
  }, [charger]);

  function marquerEnCours(id: number, actif: boolean) {
    setActionsEnCours((prev) => {
      const suivant = new Set(prev);
      if (actif) suivant.add(id);
      else suivant.delete(id);
      return suivant;
    });
  }

  async function basculerFavori(offre: Offer) {
    const cible = !offre.liked;
    // Repart d'un état propre : efface un éventuel message d'erreur précédent.
    setErreur(null);
    marquerEnCours(offre.id, true);
    // Mise à jour optimiste de l'état favori.
    setOffres((prev) => prev.map((o) => (o.id === offre.id ? { ...o, liked: cible } : o)));
    try {
      await apiClient.likeOffer(offre.id, cible);
      // Si on est sur le filtre « favoris » et qu'on retire un like, l'offre doit disparaître.
      if (filtre === "liked" && !cible) {
        setOffres((prev) => prev.filter((o) => o.id !== offre.id));
      }
    } catch (e) {
      // Annule la mise à jour optimiste en cas d'échec.
      setOffres((prev) => prev.map((o) => (o.id === offre.id ? { ...o, liked: offre.liked } : o)));
      setErreur(e instanceof Error ? e.message : "Échec de la mise à jour du favori.");
    } finally {
      marquerEnCours(offre.id, false);
    }
  }

  async function supprimer(offre: Offer) {
    // Repart d'un état propre : efface un éventuel message d'erreur précédent.
    setErreur(null);
    marquerEnCours(offre.id, true);
    // Retrait optimiste de la liste.
    setOffres((prev) => prev.filter((o) => o.id !== offre.id));
    try {
      await apiClient.deleteOffer(offre.id);
    } catch (e) {
      // Réinsère l'offre en cas d'échec, en rechargeant pour rester cohérent avec le tri serveur.
      setErreur(e instanceof Error ? e.message : "Échec de la suppression.");
      void charger();
    } finally {
      marquerEnCours(offre.id, false);
    }
  }

  return (
    <section className="offers-page" aria-label="Offres">
      <RunButton onRunFinished={charger} />

      <div className="offers-page__toolbar">
        <label>
          Affichage
          <select
            value={filtre}
            onChange={(e) => setFiltre(e.target.value as OfferFilter)}
          >
            <option value="all">Toutes</option>
            <option value="liked">Favoris</option>
          </select>
        </label>

        <label>
          Tri
          <select value={tri} onChange={(e) => setTri(e.target.value as OfferSort)}>
            <option value="recent">Plus récentes</option>
            <option value="score">Meilleur score</option>
          </select>
        </label>

        <button type="button" onClick={() => void charger()} disabled={etat === "loading"}>
          Rafraîchir
        </button>
      </div>

      {etat === "loading" && <p className="offers-page__state">Chargement des offres…</p>}
      {etat === "error" && (
        <p className="offers-page__error" role="alert">
          {erreur}
        </p>
      )}
      {etat === "ready" && offres.length === 0 && (
        <p className="offers-page__state">
          {filtre === "liked" ? "Aucun favori pour le moment." : "Aucune offre à afficher."}
        </p>
      )}
      {/* Erreur survenue après un premier chargement réussi (like/delete). */}
      {etat === "ready" && erreur && (
        <p className="offers-page__error" role="alert">
          {erreur}
        </p>
      )}

      {offres.length > 0 && (
        <ul className="offers-page__list">
          {offres.map((offre) => (
            <li key={offre.id}>
              <OfferCard
                offre={offre}
                enCours={actionsEnCours.has(offre.id)}
                onToggleLike={basculerFavori}
                onDelete={supprimer}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
