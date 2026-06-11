/**
 * Types d'offre. Repris du contrat `RawJobOffer` de Job_watcher (apps/pipeline),
 * inliné ici pour que le fork n'ait aucune dépendance au monorepo d'origine.
 */
export type RemoteType = "on_site" | "hybrid" | "full_remote";

export interface RawJobOffer {
  title: string;
  company: string | null;
  location: string | null;
  salary: string | null;
  contractType: string | null;
  urlSource: string;
  sourceName: string;
  publishedAt: Date | null;
  remoteType?: RemoteType | null;
  requiredExperienceYears?: number | null;
  descriptionRaw?: string | null;
}

export type Priority = "🔴 Haute" | "🟠 Moyenne" | "🟢 Basse";

/** Offre dédupliquée + scorée, prête pour l'export Notion. */
export interface ScoredOffer extends RawJobOffer {
  hash: string;
  score: number;
  priority: Priority;
}
