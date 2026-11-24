"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

export type SelectSize = "sm" | "md" | "lg";

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  selectSize?: SelectSize;
  invalid?: boolean;
}

const SIZE_CLASSES: Record<SelectSize, string> = {
  sm: "h-8 pl-2.5 pr-8 text-caption rounded-md",
  md: "h-10 pl-3 pr-9 text-body rounded-lg",
  lg: "h-12 pl-4 pr-10 text-body-lg rounded-lg",
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { selectSize = "md", invalid = false, className = "", children, ...rest },
  ref,
) {
  return (
    <span className="relative inline-block w-full">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={[
          "block w-full appearance-none bg-bg-subtle/40 text-text border",
          "transition-[border-color,box-shadow,background-color] hover:bg-bg-subtle/60",
          invalid
            ? "border-danger focus:border-danger focus:ring-danger/20"
            : "border-border-strong focus:border-accent focus:ring-accent/20",
          "focus:outline-none focus:ring-4",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          SIZE_CLASSES[selectSize],
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted"
      />
    </span>
  );
});
