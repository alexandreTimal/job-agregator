/**
 * Bouton « Lancer la recherche » + barre de progression live (lane Offres).
 *
 * Déclenche un run du pipeline via `apiClient.startRun()` :
 * - si un run est déjà en cours côté serveur (HTTP 423), affiche un message et
 *   ne s'abonne pas une seconde fois ;
 * - sinon ouvre le flux SSE `apiClient.streamRun(...)` pour afficher l'avancement
 *   en direct, puis appelle `onRunFinished` à la fin (event `done` ou `error`).
 *
 * Le bouton est désactivé tant qu'un run est en cours.
 *
 * Garde-fou : si le flux SSE tombe sans émettre `done`/`error` (process tué,
 * serveur crashé), `apiClient.streamRun` ferme l'EventSource sans remonter
 * d'événement (cf. lane foundation : `es.onerror = () => es.close()`). Sans
 * filet, le bouton resterait bloqué sur « Recherche en cours… » indéfiniment.
 * Un chien de garde réarme donc le bouton après une période de silence prolongée.
 * (Correctif idéal côté foundation : émettre un RunEvent `error` sur `es.onerror`.)
 */
import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "../../../src/shared/types";
import { apiClient } from "../../lib/api-client";

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

export default function RunButton({ onRunFinished }: RunButtonProps) {
  const [enCours, setEnCours] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
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
  function reactiverChienDeGarde() {
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
    }, DELAI_SILENCE_MS);
  }

  function gererEvenement(event: RunEvent) {
    // Tout événement reçu prouve que le flux est vivant : on réarme le garde-fou.
    reactiverChienDeGarde();

    if (event.type === "progress") {
      const morceaux = [
        event.term ? `terme « ${event.term} »` : null,
        event.source ? `source ${event.source}` : null,
        typeof event.found === "number" ? `${event.found} offre(s)` : null,
      ].filter(Boolean);
      setMessage(morceaux.length > 0 ? morceaux.join(" — ") : "recherche en cours…");
      return;
    }

    if (event.type === "done") {
      setMessage(event.message ?? "Recherche terminée.");
      setEnCours(false);
      arreterStream();
      onRunFinished();
      return;
    }

    // type === "error"
    setErreur(event.message ?? "La recherche a échoué.");
    setMessage(null);
    setEnCours(false);
    arreterStream();
    onRunFinished();
  }

  async function lancer() {
    if (enCours) return;
    setErreur(null);
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

  return (
    <div className="run-control">
      <button
        type="button"
        className="run-control__button"
        onClick={lancer}
        disabled={enCours}
        aria-busy={enCours}
      >
        {enCours ? "Recherche en cours…" : "Lancer la recherche"}
      </button>

      {enCours && (
        <div
          className="run-control__progress"
          role="progressbar"
          aria-label="Progression de la recherche"
        >
          <div className="run-control__progress-bar" />
        </div>
      )}

      {message && (
        <p className="run-control__message" role="status">
          {message}
        </p>
      )}
      {erreur && (
        <p className="run-control__error" role="alert">
          {erreur}
        </p>
      )}
    </div>
  );
}
