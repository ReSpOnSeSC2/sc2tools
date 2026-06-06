"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

/** Button — variants × sizes × loading/disabled, with optional icon slots. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

// Courtside buttons are pills in the display face. Primary/secondary/danger
// wear the 2px ink outline + hard offset shadow and physically COLLAPSE into
// that shadow on press (`hard-press`). Ghost stays flat and quiet.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "hard-press bg-accent text-white border-2 border-line hover:bg-accent-hover disabled:opacity-50",
  secondary:
    "hard-press bg-bg-surface text-text border-2 border-line hover:bg-bg-elevated disabled:opacity-50",
  ghost:
    "bg-transparent text-text border-2 border-transparent hover:bg-bg-elevated transition-colors disabled:opacity-50",
  danger:
    "hard-press bg-danger text-white border-2 border-line hover:bg-danger disabled:opacity-50",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-caption gap-1.5 rounded-full min-w-[44px]",
  md: "h-11 px-5 text-body gap-2 rounded-full min-w-[44px]",
  lg: "h-12 px-6 text-body-lg gap-2.5 rounded-full min-w-[44px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading = false,
      iconLeft,
      iconRight,
      fullWidth = false,
      className = "",
      disabled,
      children,
      type = "button",
      ...rest
    },
    ref,
  ) {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        className={[
          "inline-flex items-center justify-center font-display font-bold tracking-tight",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "disabled:cursor-not-allowed",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          fullWidth ? "w-full" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          iconLeft && <span className="flex-shrink-0">{iconLeft}</span>
        )}
        {children}
        {iconRight && !loading ? (
          <span className="flex-shrink-0">{iconRight}</span>
        ) : null}
      </button>
    );
  },
);
