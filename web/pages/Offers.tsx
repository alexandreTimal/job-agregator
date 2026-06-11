/**
 * Page Offres.
 *
 * Liste les offres (`apiClient.getOffers(filter, sort)`), avec :
 * - un filtre Favoris (`all` | `liked`) ;
 * - sur chaque offre, les actions Liker (POST like) et Supprimer (soft-delete,
 *   retire l'offre de la liste localement) ;
 * - un panneau de commande (RunButton) qui déclenche le run, suit la
 *   progression via SSE et rafraîchit la liste à la fin.
 *
 * Le tri reste « recent » côté serveur (les likées remontent toujours en tête,
 * cf. docs/api-contract.md). Le score existe dans le contrat d'API mais n'est
 * pas surfacé dans l'UI (pipeline non scorant) : pas de tri ni d'affichage.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Inbox, Star, Layers } from "lucide-react";
import type { Offer, OfferFilter } from "../../src/shared/types";
import { apiClient } from "../lib/api-client";
import OfferCard from "../components/offers/OfferCard";
import RunButton from "../components/offers/RunButton";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

type EtatChargement = "idle" | "loading" | "ready" | "error";

export default function Offers() {
  const [filtre, setFiltre] = useState<OfferFilter>("all");
  const [offres, setOffres] = useState<Offer[]>([]);
  const [etat, setEtat] = useState<EtatChargement>("idle");
  const [erreur, setErreur] = useState<string | null>(null);
  /** Ids des offres dont une action (like/delete) est en cours, pour désactiver leurs boutons. */
  const [actionsEnCours, setActionsEnCours] = useState<Set<number>>(new Set());

  const charger = useCallback(async () => {
    setEtat("loading");
    setErreur(null);
    try {
      const liste = await apiClient.getOffers(filtre, "recent");
      setOffres(liste);
      setEtat("ready");
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Échec du chargement des offres.");
      setEtat("error");
    }
  }, [filtre]);

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

  const vide = etat === "ready" && offres.length === 0;

  return (
    <section aria-label="Offres" aria-busy={etat === "loading"} className="flex flex-col gap-6">
      <RunButton onRunFinished={charger} />

      {/* Barre d'outils : filtre + compteur + rafraîchir */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<OfferFilter>
          aria-label="Filtrer les offres"
          value={filtre}
          onChange={setFiltre}
          options={[
            { value: "all", label: "Toutes", icon: <Inbox /> },
            { value: "liked", label: "Favoris", icon: <Star /> },
          ]}
        />

        <div className="ml-auto flex items-center gap-3">
          <span
            role="status"
            aria-live="polite"
            className="font-[family-name:var(--font-mono)] text-[0.78rem] text-[var(--color-ink-mute)]"
          >
            {etat === "ready" ? `${offres.length} offre${offres.length > 1 ? "s" : ""}` : ""}
          </span>
          <button
            type="button"
            onClick={() => void charger()}
            disabled={etat === "loading"}
            aria-label="Rafraîchir la liste"
            className="grid size-9 place-items-center rounded-[var(--radius-sm)] border border-[var(--color-line)] text-[var(--color-ink-mute)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            <RefreshCw aria-hidden="true" className={cn("size-4", etat === "loading" && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* États */}
      {etat === "loading" && offres.length === 0 && (
        <div aria-hidden="true" className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[88px] animate-pulse rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-panel)]/40"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>
      )}

      {/* Erreur (chargement initial OU action like/delete) — états mutuellement exclusifs. */}
      {erreur && (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
        >
          {erreur}
        </div>
      )}

      {vide && (
        <div className="grid place-items-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-line-strong)] bg-[var(--color-panel)]/30 px-6 py-16 text-center">
          <div
            aria-hidden="true"
            className="grid size-12 place-items-center rounded-full border border-[var(--color-line)] bg-black/20 text-[var(--color-ink-mute)]"
          >
            {filtre === "liked" ? <Star className="size-5" /> : <Layers className="size-5" />}
          </div>
          <p className="mt-4 text-[0.95rem] font-medium text-[var(--color-ink-soft)]">
            {filtre === "liked" ? "Aucun favori pour le moment" : "Aucune offre à afficher"}
          </p>
          <p className="mt-1 max-w-xs text-sm text-[var(--color-ink-mute)]">
            {filtre === "liked"
              ? "Marquez des offres d'une étoile pour les retrouver ici."
              : "Lancez une collecte pour peupler le flux."}
          </p>
        </div>
      )}

      {offres.length > 0 && (
        <>
          <h2 className="sr-only">Liste des offres</h2>
          <ul className="stagger flex flex-col gap-2.5">
            {offres.map((offre, i) => (
              <li key={offre.id} style={{ "--i": Math.min(i, 12) } as React.CSSProperties}>
                <OfferCard
                  offre={offre}
                  enCours={actionsEnCours.has(offre.id)}
                  onToggleLike={basculerFavori}
                  onDelete={supprimer}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
