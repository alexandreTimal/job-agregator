/**
 * Bouton — primitive façon shadcn (cva), habillée pour le thème control-room.
 *
 * Variants : signal (action principale lime), ghost, outline, danger.
 * Tailles : sm, md, lg, icon.
 */
import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium select-none " +
    "transition-all duration-200 ease-[var(--ease-out-expo)] outline-none " +
    "disabled:pointer-events-none disabled:opacity-45 " +
    "active:translate-y-px [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        signal:
          "bg-[var(--color-signal)] text-[#0a0b0a] font-semibold " +
          "shadow-[0_0_0_1px_var(--color-signal-dim),0_10px_30px_-12px_var(--color-signal-glow)] " +
          "hover:bg-[#d4fa60] hover:shadow-[0_0_0_1px_var(--color-signal),0_14px_38px_-12px_var(--color-signal-glow)]",
        outline:
          "border border-[var(--color-line-strong)] bg-[var(--color-panel)]/60 text-[var(--color-ink)] " +
          "hover:border-[var(--color-signal)]/50 hover:bg-[var(--color-panel-2)] hover:text-white",
        ghost:
          "text-[var(--color-ink-soft)] hover:bg-white/5 hover:text-[var(--color-ink)]",
        danger:
          "border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-danger)] " +
          "hover:bg-[var(--color-danger)]/20 hover:border-[var(--color-danger)]/55",
      },
      size: {
        sm: "h-8 rounded-[var(--radius-xs)] px-3 text-xs",
        md: "h-10 rounded-[var(--radius-sm)] px-4 text-sm",
        lg: "h-12 rounded-[var(--radius-md)] px-6 text-[0.95rem]",
        icon: "h-9 w-9 rounded-[var(--radius-sm)]",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
