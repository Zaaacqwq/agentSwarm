import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "quiet" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-honey text-honey-ink font-semibold shadow-glow hover:bg-[oklch(85%_0.15_78)] active:translate-y-px disabled:opacity-50 disabled:shadow-none",
  ghost: "border border-line-strong text-ink hover:border-honey/60 hover:bg-raised active:bg-sunken disabled:opacity-40",
  quiet: "text-muted hover:text-ink hover:bg-raised active:bg-sunken disabled:opacity-40",
  danger: "border border-err/40 text-err hover:bg-err/10 active:bg-err/20 disabled:opacity-40",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export function Button({ variant = "ghost", size = "md", icon, className = "", children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center rounded-pill transition-[background,border-color,transform,color] duration-[var(--duration-fast)] ease-[var(--ease-out-expo)] ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
