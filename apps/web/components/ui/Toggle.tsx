"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

/**
 * Toggle — boolean switch styled as a sliding pill.
 * Use this for on/off settings; for tri-state, use a Select.
 */
export interface ToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onChange, label, disabled, className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full",
        "border border-border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-bg-elevated",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      <span
        aria-hidden
        className={[
          "inline-block h-4 w-4 rounded-full bg-white shadow-sm",
          "transition-transform duration-150",
          checked ? "translate-x-6" : "translate-x-1",
        ].join(" ")}
      />
    </button>
  );
});
