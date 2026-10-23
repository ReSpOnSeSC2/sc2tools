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

// Courtside buttons are pills in the display face. Primary/secondary/danger
// wear the 2px ink outline + hard offset shadow and physically COLLAPSE into
// that shadow on press (`hard-press`). Ghost stays flat and quiet.
export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "hard-press bg-accent text-white border-2 border-line hover:bg-accent-hover disabled:opacity-50",
  secondary:
    "hard-press bg-bg-surface text-text border-2 border-line hover:bg-bg-elevated disabled:opacity-50",
  ghost:
    "bg-transparent text-text border-2 border-transparent hover:bg-bg-elevated transition-colors disabled:opacity-50",
  danger:
    "hard-press bg-danger text-white border-2 border-line hover:bg-danger disabled:opacity-50",
};

export const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-caption gap-1.5 rounded-full min-w-[44px]",
  md: "h-11 px-5 text-body gap-2 rounded-full min-w-[44px]",
  lg: "h-12 px-6 text-body-lg gap-2.5 rounded-full min-w-[44px]",
};

export const BUTTON_BASE_CLASSES = [
  "inline-flex items-center justify-center font-display font-bold tracking-tight",
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
