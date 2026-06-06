"use client";

import type { ReactNode } from "react";

/**
 * Stat — labelled metric card.
 * Composes inside a Card or Section grid for KPI rows.
 */
export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  trend?: "up" | "down" | "flat";
  trendLabel?: ReactNode;
  size?: "sm" | "md" | "lg";
  align?: "left" | "center";
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<StatProps["size"]>, string> = {
  sm: "p-3 gap-1",
  md: "p-4 gap-1.5",
  lg: "p-5 gap-2",
};

const VALUE_CLASSES: Record<NonNullable<StatProps["size"]>, string> = {
  sm: "text-h4",
  md: "text-h2",
  lg: "text-h1",
};

const TREND_CLASSES = {
  up: "text-success",
  down: "text-danger",
  flat: "text-text-muted",
} as const;

export function StatCard({
  label,
  value,
  hint,
  trend,
  trendLabel,
  size = "md",
  align = "left",
  className = "",
}: StatProps) {
  return (
    <div
      className={[
        // Courtside KPI card: 2px ink outline + hard offset shadow.
        "flex flex-col rounded-xl border-2 border-line bg-bg-surface shadow-hard",
        SIZE_CLASSES[size],
        align === "center" ? "items-center text-center" : "items-start",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="text-micro font-medium uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div
        className={[
          "font-display font-bold tabular-nums leading-none",
          VALUE_CLASSES[size],
        ].join(" ")}
      >
        {value}
      </div>
      {trend && trendLabel ? (
        <div
          className={[
            "text-caption font-medium",
            TREND_CLASSES[trend],
          ].join(" ")}
        >
          {trend === "up" ? "▲" : trend === "down" ? "▼" : "·"} {trendLabel}
        </div>
      ) : null}
      {hint ? (
        <div className="text-caption text-text-muted">{hint}</div>
      ) : null}
    </div>
  );
}
