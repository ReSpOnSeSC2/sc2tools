/**
 * Class recipe shared by <Button> and links that should look like one.
 *
 * Kept out of Button.tsx (a client module) so server components can
 * style a next/link as a pill without importing client code.
 *
 * Example:
 *   <Link href="/" className={buttonClassName({ variant: "primary" })}>Go home</Link>
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

// Command Glass buttons are pills. Primary and danger are lit fills with a
// top highlight and a soft glow on hover (`btn-primary` / `btn-danger` in
// globals.css); secondary is a raised glass surface on a hairline edge;
// ghost stays flat and quiet. Every variant presses in with a gentle scale.
export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "btn-primary bg-accent text-white border border-white/10 hover:bg-accent-hover disabled:opacity-50",
  secondary:
    "btn-secondary bg-bg-elevated text-text border border-line hover:border-border-strong hover:bg-bg-subtle disabled:opacity-50",
  ghost:
    "bg-transparent text-text border border-transparent hover:bg-bg-subtle disabled:opacity-50",
  danger:
    "btn-danger bg-danger text-white border border-white/10 hover:bg-danger disabled:opacity-50",
};

export const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-caption gap-1.5 rounded-full min-w-[44px]",
  md: "h-11 px-5 text-body gap-2 rounded-full min-w-[44px]",
  lg: "h-12 px-6 text-body-lg gap-2.5 rounded-full min-w-[44px]",
};

export const BUTTON_BASE_CLASSES = [
  "inline-flex items-center justify-center font-display font-semibold tracking-[-0.01em] select-none",
  "transition-[color,background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.97] disabled:active:scale-100",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  "disabled:cursor-not-allowed",
].join(" ");

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

/** The full class list for a button (or button-styled link). */
export function buttonClassName({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className = "",
}: ButtonClassOptions = {}): string {
  return [
    BUTTON_BASE_CLASSES,
    BUTTON_VARIANT_CLASSES[variant],
    BUTTON_SIZE_CLASSES[size],
    fullWidth ? "w-full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}
