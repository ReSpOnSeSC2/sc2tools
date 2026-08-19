"use client";

/**
 * ReplayIcon — one unit / structure thumbnail for the rails.
 *
 * Uses the shipped flat icon set (``lib/sc2-icons``), NOT the 3D sprite
 * sheets. The sheets would look better here, but ``spriteSheets`` draws
 * through module-level per-frame state (``beginSpriteFrame`` resets the
 * atlas build budget and the LRU stamp for the whole module), so
 * rasterising a thumbnail from a rail would corrupt the accounting the
 * 60 fps canvas loop depends on. Getting sprites into the rails means
 * giving ``spriteSheets`` a standalone "rasterise one cell, off the
 * frame budget" entry point — worth doing, out of scope for this pass.
 *
 * Names with no icon fall back to a monogram tile rather than a gap, so
 * a row's shape never depends on asset coverage.
 */

import { memo } from "react";
import { getIconPath } from "@/lib/sc2-icons";
import { prettyName } from "@/lib/replayHud";

function ReplayIconImpl({
  name,
  kind,
  className = "h-5 w-5",
}: {
  name: string;
  kind: "unit" | "structure";
  className?: string;
}) {
  const src = getIconPath(name, kind === "structure" ? "building" : "unit");
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        className={`${className} shrink-0 rounded-sm object-contain`}
      />
    );
  }
  const monogram = prettyName(name)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={`${className} inline-flex shrink-0 items-center justify-center rounded-sm border border-border bg-bg-subtle text-[0.55rem] font-semibold leading-none text-text-dim`}
    >
      {monogram}
    </span>
  );
}

export const ReplayIcon = memo(ReplayIconImpl);
