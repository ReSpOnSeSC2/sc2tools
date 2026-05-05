"use client";

import { useState, type CSSProperties } from "react";
import Image from "next/image";
import {
  getIconPath,
  type IconKind,
} from "@/lib/sc2-icons";

export type IconSize = number | "sm" | "md" | "lg" | "xl";

export interface IconProps {
  /** Free-form SC2 name — "nexus", "Probe", "void ray", etc. */
  name: string;
  /** Disambiguates collisions and improves alt-text (e.g. "Speed" upgrade vs unit). */
  kind?: IconKind;
  /** Optional race hint surfaced via aria-label, no visual effect. */
  race?: "Z" | "P" | "T" | "R" | "Zerg" | "Protoss" | "Terran" | "Random";
  size?: IconSize;
  /** Visible text shown if the icon is missing or fails to load. */
  fallback?: string;
  className?: string;
  /** Custom alt text. Defaults to `name`. */
  alt?: string;
  /** Decorative — sets alt="" and aria-hidden. */
  decorative?: boolean;
}

const SIZE_PX: Record<Exclude<IconSize, number>, number> = {
  sm: 16,
  md: 24,
  lg: 32,
  xl: 48,
};

/**
 * Icon — SC2 building/unit/upgrade/race/league icon.
 * Resolves names through lib/sc2-icons (camelCase, spaces, prefixes).
 * Falls back to a muted text label if the icon is missing.
 */
export function Icon({
  name,
  kind,
  race,
  size = "md",
  fallback,
  className = "",
  alt,
  decorative = false,
}: IconProps) {
  const [errored, setErrored] = useState(false);
  const px = typeof size === "number" ? size : SIZE_PX[size];
  const src = getIconPath(name, kind);

  const labelText = alt ?? name;
  const ariaLabel =
    decorative
      ? undefined
      : race
        ? `${labelText} (${race})`
        : labelText;

  if (!src || errored) {
    return (
      <span
        role={decorative ? undefined : "img"}
        aria-hidden={decorative || undefined}
        aria-label={ariaLabel}
        title={ariaLabel}
        style={{ height: px, lineHeight: `${px}px` } as CSSProperties}
        className={[
          "inline-flex items-center justify-center rounded bg-bg-elevated px-1 text-[10px] font-medium uppercase tracking-wide text-text-dim",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {fallback ?? labelText.slice(0, 3)}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt={decorative ? "" : (alt ?? labelText)}
      aria-label={ariaLabel}
      aria-hidden={decorative || undefined}
      width={px}
      height={px}
      className={["inline-block flex-shrink-0", className].filter(Boolean).join(" ")}
      onError={() => setErrored(true)}
      unoptimized
    />
  );
}
