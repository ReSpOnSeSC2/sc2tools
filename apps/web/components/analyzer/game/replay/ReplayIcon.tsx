"use client";

/**
 * ReplayIcon — one unit / structure thumbnail for the rails.
 *
 * Renders the SAME 3D model the map draws, from the pre-rendered
 * roster icons at ``<SPRITE_BASE>/icons/<Name>_<red|blue>.webp`` (128 px,
 * transparent). A plain ``<img>``, deliberately: the sprite SHEETS
 * cannot be used here, because ``spriteSheets`` rasterises through
 * module-level per-frame state (``beginSpriteFrame`` resets the atlas
 * build budget and the LRU stamp for the whole module) that the 60 fps
 * canvas loop owns. A DOM list must never touch it. The icons are a
 * separate, static asset for exactly that reason.
 *
 * FALLBACK CHAIN, in order:
 *   1. the 3D roster icon, when ``canonicalSpriteName`` resolves the
 *      playback name onto a sheet (``BarracksTechLab`` → ``TechLab``);
 *   2. the flat command-card icon from ``lib/sc2-icons`` when it does
 *      not — Broodling and the Adept phase-shift have no extractable
 *      model, and UPGRADES have no 3D render at all;
 *   3. the flat icon again at RUNTIME if the render 404s (``onError``),
 *      so a missing file degrades instead of showing a broken image;
 *   4. a monogram tile, so a row's shape never depends on asset
 *      coverage.
 *
 * Colour follows the map: "me" takes the blue sheets, the opponent red
 * (``ME_SHEET`` / ``OPP_SHEET`` in ``MapReplayer``). Callers that have
 * no side — a neutral legend — get blue.
 */

import { memo, useState } from "react";
import { canonicalSpriteName, spriteIconUrl } from "@/lib/spriteSheets";
import { getIconPath } from "@/lib/sc2-icons";
import { prettyName, type ReplaySide } from "@/lib/replayHud";

/** HUD icon kind → ``lib/sc2-icons`` kind. The rails speak
 *  "structure"; the icon registry speaks "building". */
const FLAT_KIND = {
  unit: "unit",
  structure: "building",
  upgrade: "upgrade",
} as const;

export type ReplayIconKind = keyof typeof FLAT_KIND;

function ReplayIconImpl({
  name,
  kind,
  side = "me",
  className = "h-5 w-5",
}: {
  name: string;
  kind: ReplayIconKind;
  /** Owner, for the team-coloured render. Defaults to "me" (blue). */
  side?: ReplaySide;
  className?: string;
}) {
  // The render URL that 404'd, not a bare boolean: this component is
  // memoized inside long lists, so the same instance can be re-rendered
  // with a different name, and a boolean would keep suppressing the new
  // (perfectly fine) render.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const flat = getIconPath(name, FLAT_KIND[kind]);
  // Upgrades never have a 3D render; ``canonicalSpriteName`` would only
  // ever miss on them anyway, but skipping the lookup keeps the intent
  // explicit and the flat icon authoritative for that kind.
  const sheet = kind === "upgrade" ? null : canonicalSpriteName(name);
  const render = sheet ? spriteIconUrl(sheet, side === "me" ? "blue" : "red") : null;
  const useRender = render !== null && render !== failedSrc;
  const src = useRender ? render : flat;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        data-icon-source={useRender ? "sprite" : "flat"}
        onError={() => setFailedSrc(render)}
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
