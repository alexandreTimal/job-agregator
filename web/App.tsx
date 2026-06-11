/**
 * Shell de l'UI : navigation 3 pages (Paramètres / Stats / Offres) + layout.
 *
 * Routeur minimal basé sur le hash (#/offres, #/stats, #/parametres) pour
 * éviter une dépendance de routing supplémentaire. Les pages elles-mêmes sont
 * implémentées par d'autres agents (cf. web/pages/*).
 */
import { useEffect, useState } from "react";
import Settings from "./pages/Settings";
import Stats from "./pages/Stats";
import Offers from "./pages/Offers";

type Route = "offres" | "stats" | "parametres";

const ROUTES: { id: Route; label: string }[] = [
  { id: "offres", label: "Offres" },
  { id: "stats", label: "Stats" },
  { id: "parametres", label: "Paramètres" },
];

function currentRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "stats" || hash === "parametres") return hash;
  return "offres";
}

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute());

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <strong>job-agregator</strong>
        <nav className="app-nav">
          {ROUTES.map((r) => (
            <a
              key={r.id}
              href={`#/${r.id}`}
              aria-current={route === r.id ? "page" : undefined}
            >
              {r.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {route === "offres" && <Offers />}
        {route === "stats" && <Stats />}
        {route === "parametres" && <Settings />}
      </main>
    </div>
  );
}
