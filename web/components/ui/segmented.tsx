/**
 * Contrôle segmenté (choix exclusif) — utilisé pour le filtre sur Offres.
 *
 * Sémantique : `radiogroup` + `radio` (et NON tablist/tab, qui impliqueraient
 * des tabpanels). Navigation clavier complète : flèches pour parcourir, un seul
 * tabstop (roving tabindex) sur l'option active.
 */
import { useRef } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  "aria-label"?: string;
  className?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  ...rest
}: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (index - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={rest["aria-label"]}
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-line)] " +
          "bg-black/30 p-1",
        className,
      )}
    >
      {options.map((opt, index) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] px-3 py-1.5 text-xs font-medium " +
                "transition-all duration-200 ease-[var(--ease-out-expo)] [&_svg]:size-3.5",
              active
                ? "bg-[var(--color-signal)]/12 text-[var(--color-signal)] shadow-[inset_0_0_0_1px_#c8f24c40]"
                : "text-[var(--color-ink-mute)] hover:text-[var(--color-ink)]",
            )}
          >
            <span aria-hidden="true" className="contents">
              {opt.icon}
            </span>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
