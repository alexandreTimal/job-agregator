/**
 * Classification DÉTERMINISTE du type de contrat d'une offre.
 *
 * Le produit ne pilote que deux familles (`stage` / `CDI`, cf. `settings`
 * `contractTypes` et `src/filter.ts`) : la classification est donc **binaire**.
 * Tout ce qui n'est pas reconnu comme un stage/alternance retombe sur `CDI`
 * (défaut majoritaire du contexte). Fonction PURE — aucun I/O, aucun état.
 *
 * Stratégie : on s'appuie d'abord sur le `contractType` brut de la source quand
 * il existe (plus fiable : WTTJ/Lever/Hellowork le renseignent), puis sur le
 * **titre** en repli (LinkedIn/Greenhouse le laissent `null`). Les deux sont
 * concaténés et normalisés, puis comparés par **préfixe de token** — ce qui
 * évite les faux positifs de sous-chaîne (ex. « international » ⊅ stage).
 */
import { normalizeText } from "./normalize";

export type ContractClass = "stage" | "CDI";

/** Préfixes de token signalant un stage / une alternance (texte normalisé). */
const STAGE_PREFIXES = ["stage", "stagiaire", "alternan", "apprenti", "internship"];

/**
 * Classe une offre en `"stage"` ou `"CDI"`.
 *
 * @param title Titre de l'offre (toujours présent).
 * @param raw   `contractType` brut de la source (souvent `null`).
 */
export function classifyContractType(title: string, raw?: string | null): ContractClass {
  const tokens = normalizeText(`${raw ?? ""} ${title}`).split(" ").filter(Boolean);
  const isStage = tokens.some((t) => STAGE_PREFIXES.some((p) => t.startsWith(p)));
  return isStage ? "stage" : "CDI";
}
