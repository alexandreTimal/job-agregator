/**
 * Hook de suivi des candidatures (CV + lettre générés localement par offre).
 *
 * - Ouvre UN flux SSE global (`/api/candidatures/stream`) au montage et tient à
 *   jour une carte `offerId → CandidatureState`. Plusieurs offres peuvent générer
 *   en parallèle (pas de verrou global côté serveur) : le hash reflète tout.
 * - `ensure(id)` : charge l'état d'une offre encore inconnue (GET), sans écraser
 *   un état déjà poussé par le flux. Appelé quand on ouvre le panneau d'une offre.
 * - `generate(id, instruction?)` : lance/relance la génération (POST) avec MAJ
 *   optimiste ; la suite arrive par le flux SSE.
 */
import { useCallback, useEffect, useState } from "react";
import type { CandidatureState } from "../../src/shared/types";
import { apiClient } from "./api-client";

function placeholder(id: number, status: CandidatureState["status"], from?: CandidatureState): CandidatureState {
  return {
    offerId: id,
    status,
    cvReady: from?.cvReady ?? false,
    lettreReady: from?.lettreReady ?? false,
    generatedAt: from?.generatedAt ?? null,
    error: status === "failed" ? from?.error ?? null : null,
  };
}

export function useCandidatures() {
  const [states, setStates] = useState<Record<number, CandidatureState>>({});

  useEffect(() => {
    const close = apiClient.streamCandidatures((event) => {
      setStates((prev) => ({ ...prev, [event.offerId]: event }));
    });
    return close;
  }, []);

  const ensure = useCallback((id: number) => {
    setStates((prev) => prev); // pas d'effet visuel immédiat
    void apiClient
      .getCandidature(id)
      .then((s) => setStates((prev) => (prev[id] ? prev : { ...prev, [id]: s })))
      .catch(() => {
        /* lecture best-effort : un échec laisse simplement l'état inconnu */
      });
  }, []);

  const generate = useCallback((id: number, instruction?: string) => {
    setStates((prev) => ({ ...prev, [id]: placeholder(id, "queued", prev[id]) }));
    void apiClient
      .generateCandidature(id, instruction)
      .then((s) => setStates((prev) => ({ ...prev, [id]: s })))
      .catch((e) =>
        setStates((prev) => ({
          ...prev,
          [id]: { ...placeholder(id, "failed", prev[id]), error: e instanceof Error ? e.message : "échec du lancement" },
        })),
      );
  }, []);

  return { states, ensure, generate };
}
