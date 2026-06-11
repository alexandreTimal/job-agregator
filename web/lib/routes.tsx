/** Métadonnées des 3 routes — partagées par le shell (sidebar + en-tête de page). */
import { Layers, BarChart3, SlidersHorizontal, type LucideIcon } from "lucide-react";

export type RouteId = "offres" | "stats" | "parametres";

export interface RouteMeta {
  id: RouteId;
  label: string;
  /** Index affiché en mono dans la sidebar. */
  index: string;
  icon: LucideIcon;
  /** Grand titre éditorial de la page. */
  title: string;
  /** Accroche secondaire. */
  tagline: string;
}

export const ROUTES: RouteMeta[] = [
  {
    id: "offres",
    label: "Offres",
    index: "01",
    icon: Layers,
    title: "Le flux",
    tagline: "Toutes les offres collectées, filtrées par vos propres règles.",
  },
  {
    id: "stats",
    label: "Stats",
    index: "02",
    icon: BarChart3,
    title: "Le tableau de bord",
    tagline: "Volume, sources et historique des passages du pipeline.",
  },
  {
    id: "parametres",
    label: "Paramètres",
    index: "03",
    icon: SlidersHorizontal,
    title: "La console",
    tagline: "Termes recherchés, types de contrat et sources interrogées.",
  },
];

export function routeFromHash(): RouteId {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "stats" || hash === "parametres") return hash;
  return "offres";
}
