"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { buttonClassName, type ButtonSize, type ButtonVariant } from "./buttonStyles";

/** Button — variants × sizes × loading/disabled, with optional icon slots. */
export type { ButtonSize, ButtonVariant };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

// The variant × size class recipe lives in buttonStyles.ts so links can
// wear the same pill (see buttonClassName).
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
        className={buttonClassName({ variant, size, fullWidth, className })}
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
