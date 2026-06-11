/** Petit badge / pastille (source, état, compteur). */
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-none",
  {
    variants: {
      tone: {
        neutral:
          "border-[var(--color-line-strong)] bg-white/[0.03] text-[var(--color-ink-soft)]",
        signal:
          "border-[var(--color-signal)]/30 bg-[var(--color-signal)]/10 text-[var(--color-signal)]",
        amber:
          "border-[var(--color-amber)]/30 bg-[var(--color-amber)]/10 text-[var(--color-amber)]",
        mono: "border-[var(--color-line-strong)] bg-black/30 font-[family-name:var(--font-mono)] text-[var(--color-ink-soft)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
