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

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:bg-accent-hover active:translate-y-px disabled:opacity-50",
  secondary:
    "bg-bg-elevated text-text border border-border hover:bg-bg-subtle hover:border-border-strong disabled:opacity-50",
  ghost:
    "bg-transparent text-text hover:bg-bg-elevated disabled:opacity-50",
  danger:
    "bg-danger text-white hover:opacity-90 active:translate-y-px disabled:opacity-50",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-caption gap-1.5 rounded-md min-w-[44px]",
  md: "h-10 px-4 text-body gap-2 rounded-lg min-w-[44px]",
  lg: "h-12 px-5 text-body-lg gap-2.5 rounded-lg min-w-[44px]",
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
          "inline-flex items-center justify-center font-semibold",
          "transition-colors transition-transform duration-100",
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
