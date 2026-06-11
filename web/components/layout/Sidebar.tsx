/**
 * Navigation latérale persistante — colonne « instrument » du control-room.
 *
 * Desktop : rail vertical fixe (wordmark, nav indexée, état localhost).
 * Mobile  : se replie en barre supérieure compacte (cf. classes responsives).
 */
import { ROUTES, type RouteId } from "@/lib/routes";
import { cn } from "@/lib/utils";

interface SidebarProps {
  current: RouteId;
}

export function Sidebar({ current }: SidebarProps) {
  return (
    <aside
      className={cn(
        "z-20 flex shrink-0 flex-col border-[var(--color-line)] bg-[var(--color-surface)]/80 backdrop-blur-md",
        // Desktop : rail vertical collant.
        "lg:sticky lg:top-0 lg:h-screen lg:w-[248px] lg:border-r",
        // Mobile : barre horizontale collante en haut.
        "sticky top-0 w-full border-b",
      )}
    >
      {/* Wordmark */}
      <div className="flex items-center gap-3 px-5 py-5 lg:px-6 lg:py-7">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full rounded-full bg-[var(--color-signal)] [animation:pulse-dot_2.4s_ease-in-out_infinite]" />
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[0.82rem] font-medium tracking-tight text-[var(--color-ink)]">
          job<span className="text-[var(--color-ink-faint)]">·</span>agregator
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex gap-1 px-3 lg:mt-2 lg:flex-col lg:px-3">
        {ROUTES.map((r) => {
          const active = r.id === current;
          const Icon = r.icon;
          return (
            <a
              key={r.id}
              href={`#/${r.id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex flex-1 items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-sm " +
                  "transition-colors duration-200 lg:flex-none",
                active
                  ? "bg-white/[0.04] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-mute)] hover:bg-white/[0.025] hover:text-[var(--color-ink-soft)]",
              )}
            >
              {/* Marqueur signal du segment actif */}
              <span
                className={cn(
                  "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--color-signal)] " +
                    "transition-all duration-300 ease-[var(--ease-out-expo)]",
                  active ? "opacity-100" : "opacity-0",
                )}
              />
              <Icon
                className={cn(
                  "size-[1.05rem] shrink-0 transition-colors",
                  active ? "text-[var(--color-signal)]" : "text-[var(--color-ink-faint)] group-hover:text-[var(--color-ink-mute)]",
                )}
              />
              <span className="font-medium">{r.label}</span>
              <span className="ml-auto hidden font-[family-name:var(--font-mono)] text-[0.7rem] text-[var(--color-ink-faint)] lg:inline">
                {r.index}
              </span>
            </a>
          );
        })}
      </nav>

      {/* Pied : état du serveur local */}
      <div className="mt-auto hidden px-5 pb-6 lg:block">
        <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-black/20 p-3">
          <div className="flex items-center gap-2 font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-wider text-[var(--color-ink-mute)]">
            <span className="size-1.5 rounded-full bg-[var(--color-signal)]" />
            127.0.0.1
          </div>
          <p className="mt-1.5 text-[0.7rem] leading-relaxed text-[var(--color-ink-faint)]">
            Instance locale, mono-utilisateur. Déterministe, sans LLM.
          </p>
        </div>
      </div>
    </aside>
  );
}
