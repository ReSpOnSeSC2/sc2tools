"use client";

import { forwardRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { buttonClassName, type ButtonSize, type ButtonVariant } from "./buttonStyles";

/** Button — variants × sizes × loading/disabled, with optional icon slots. */
export type { ButtonSize, ButtonVariant };
export { buttonClassName, buttonClassName as buttonClasses } from "./buttonStyles";

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

export type LinkButtonProps = Omit<ComponentProps<typeof Link>, "ref"> &
  Pick<ButtonProps, "variant" | "size" | "iconLeft" | "iconRight" | "fullWidth">;

/** Navigation with the same class recipe and icon slots as Button. */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(
  function LinkButton({ variant = "primary", size = "md", iconLeft, iconRight, fullWidth = false, className = "", children, ...props }, ref) {
    return <Link ref={ref} className={buttonClassName({ variant, size, fullWidth, className })} {...props}>
      {iconLeft ? <span className="flex-shrink-0">{iconLeft}</span> : null}
      {children}
      {iconRight ? <span className="flex-shrink-0">{iconRight}</span> : null}
    </Link>;
  },
);
