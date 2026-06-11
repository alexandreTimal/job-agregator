/**
 * Shell de l'UI : sidebar persistante + zone de contenu avec en-tête éditorial.
 *
 * Routeur minimal basé sur le hash (#/offres, #/stats, #/parametres) pour
 * éviter une dépendance de routing. Les pages vivent dans web/pages/*.
 */
import { useEffect, useState } from "react";
import { ROUTES, routeFromHash, type RouteId } from "@/lib/routes";
import { Sidebar } from "@/components/layout/Sidebar";
import Settings from "@/pages/Settings";
import Stats from "@/pages/Stats";
import Offers from "@/pages/Offers";

export default function App() {
  const [route, setRoute] = useState<RouteId>(routeFromHash());

  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const meta = ROUTES.find((r) => r.id === route) ?? ROUTES[0]!;

  return (
    <div className="relative z-10 flex min-h-screen flex-col lg:flex-row">
      <Sidebar current={route} />

      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1080px] px-5 py-8 sm:px-8 lg:px-12 lg:py-14">
          {/* En-tête éditorial de la page */}
          <header key={route} className="animate-rise mb-8 lg:mb-11">
            <div className="flex items-center gap-2.5 font-[family-name:var(--font-mono)] text-[0.7rem] uppercase tracking-[0.2em] text-[var(--color-ink-mute)]">
              <span className="text-[var(--color-signal)]">/{meta.id}</span>
              <span className="h-px w-8 bg-[var(--color-line-strong)]" />
              <span>{meta.index} — 03</span>
            </div>
            <h1 className="mt-3 font-[family-name:var(--font-serif)] text-[2.6rem] leading-[1.04] tracking-[-0.01em] text-[var(--color-ink)] sm:text-[3.4rem]">
              {meta.title}
            </h1>
            <p className="mt-2 max-w-xl text-balance text-[0.95rem] leading-relaxed text-[var(--color-ink-mute)]">
              {meta.tagline}
            </p>
          </header>

          {/* Corps de page */}
          <div key={`body-${route}`} className="animate-fade">
            {route === "offres" && <Offers />}
            {route === "stats" && <Stats />}
            {route === "parametres" && <Settings />}
          </div>
        </div>
      </main>
    </div>
  );
}
