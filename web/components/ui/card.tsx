/** Panneau de base de l'UI — surface élevée, bord fin, ombre douce. */
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Card = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-panel)]/70 " +
          "shadow-[var(--shadow-panel)] backdrop-blur-sm",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";
