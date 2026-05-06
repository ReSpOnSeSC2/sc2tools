"use client";

import type { HTMLAttributes, ReactNode } from "react";

export type BadgeVariant =
  | "neutral"
  | "accent"
  | "cyan"
  | "success"
  | "warning"
  | "danger";

export type BadgeSize = "sm" | "md";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  iconLeft?: ReactNode;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-bg-elevated text-text-muted border-border",
  accent: "bg-accent/15 text-accent border-accent/30",
  cyan: "bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30",
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  danger: "bg-danger/15 text-danger border-danger/30",
};

// `min-h-` (not `h-`) so a badge that wraps to two lines (e.g. a long
// build name in a narrow table column) grows to enclose the wrapped
// text instead of clipping into a tiny stranded pill behind it.
const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: "min-h-5 py-0.5 px-1.5 text-[11px] gap-1",
  md: "min-h-6 py-0.5 px-2 text-caption gap-1.5",
};

export function Badge({
  variant = "neutral",
  size = "md",
  iconLeft,
  className = "",
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border font-medium",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {iconLeft ? (
        <span className="flex-shrink-0" aria-hidden>
          {iconLeft}
        </span>
      ) : null}
      {children}
    </span>
  );
}
