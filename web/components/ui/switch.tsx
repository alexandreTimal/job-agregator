/** Interrupteur on/off accessible (rôle switch) — sources & types de contrat. */
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

export function Switch({ checked, onChange, id, className, ...rest }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={rest["aria-label"]}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border " +
          "transition-colors duration-[250ms] ease-[var(--ease-out-expo)]",
        checked
          ? "border-[var(--color-signal)]/50 bg-[var(--color-signal)]/25"
          : "border-[var(--color-line-strong)] bg-black/40",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute left-0.5 size-4 rounded-full transition-all duration-[250ms] ease-[var(--ease-out-expo)]",
          checked
            ? "translate-x-4 bg-[var(--color-signal)] shadow-[0_0_12px_var(--color-signal-glow)]"
            : "translate-x-0 bg-[var(--color-ink-mute)]",
        )}
      />
    </button>
  );
}
