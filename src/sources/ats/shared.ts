/**
 * Briques partagées des adapters ATS (Greenhouse, Lever).
 *
 * Les API d'ATS renvoient TOUT le board d'une entreprise (pas de recherche
 * serveur). `matchesAnyTerm` émule donc le `keyword` que les sources web
 * obtiennent côté serveur : une offre n'est gardée que si son TITRE matche au
 * moins un terme. C'est une recherche, pas un filtre métier — `src/filter.ts`
 * reste pur et inchangé.
 */
import { normalizeText } from "../../lib/normalize";

/** Vrai si `title` contient au moins un des `terms` (insensible casse/accents). */
export function matchesAnyTerm(title: string, terms: string[]): boolean {
  const haystack = normalizeText(title);
  if (!haystack) return false;
  return terms.some((t) => {
    const needle = normalizeText(t);
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * GET JSON best-effort : renvoie l'objet parsé, ou `null` sur toute anomalie
 * (statut non-2xx, corps non-JSON, erreur réseau, timeout). Ne jette jamais —
 * une source ATS qui interroge plusieurs boards ne doit pas casser sur un seul.
 */
export async function fetchJson<T = unknown>(url: string, timeoutMs = 15_000): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: "application/json", "user-agent": "job-agregator/0.1 (+local)" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
