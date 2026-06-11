/** Champ texte de base, accordé au thème. */
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] " +
          "bg-black/30 px-3.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] " +
          "transition-colors duration-200 outline-none " +
          "focus:border-[var(--color-signal)]/60 focus:bg-black/45",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
