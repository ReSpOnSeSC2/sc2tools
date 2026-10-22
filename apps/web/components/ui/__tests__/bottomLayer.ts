/**
 * Test helpers for the bottom layer: what `bottom-above-chrome` and the
 * z-index tokens in tailwind.config.ts resolve to. jsdom does no layout,
 * so tests check the class a surface uses and evaluate the token's CSS
 * here with the --chrome-bottom value AppChrome published.
 */
import tailwindConfig from "@/tailwind.config";

type Extend = { inset: Record<string, string>; zIndex: Record<string, string> };
const extend = tailwindConfig.theme?.extend as unknown as Extend;

/** The CSS `bottom` value behind the `bottom-above-chrome` class. */
export const ABOVE_CHROME_CSS = extend.inset["above-chrome"];

/** Named layers: nav, sheet, banner, toast. */
export const Z_LAYERS = Object.fromEntries(
  Object.entries(extend.zIndex).map(([name, value]) => [name, Number(value)]),
) as Record<"nav" | "sheet" | "banner" | "toast", number>;

/**
 * Distance in px from the viewport bottom to a `bottom-above-chrome`
 * surface, for a given --chrome-bottom ("64px", or null when unset) and
 * safe-area inset.
 *
 * Example: `aboveChromeBottomPx("64px")` → 76.
 */
export function aboveChromeBottomPx(chromeBottom: string | null, safeAreaPx = 0): number {
  const resolved = ABOVE_CHROME_CSS.replace(
    /var\(--chrome-bottom, ([^)]+)\)/,
    (_all, fallback: string) => chromeBottom || fallback,
  ).replace(/env\(safe-area-inset-bottom, [^)]+\)/, `${safeAreaPx}px`);
  const match = /^calc\(max\(([\d.]+)px, ([\d.]+)px\) \+ ([\d.]+)rem\)$/.exec(resolved);
  if (!match) throw new Error(`Unexpected bottom-above-chrome value: ${resolved}`);
  return Math.max(Number(match[1]), Number(match[2])) + Number(match[3]) * 16;
}
