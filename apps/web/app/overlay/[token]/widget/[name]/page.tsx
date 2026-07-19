import { OverlayWidgetClient } from "@/components/OverlayWidgetClient";
import { OVERLAY_THEME_PARAM } from "@/lib/overlayTheme";
import { GHOST_BUILD_PARAM } from "@/lib/ghostBuild";

export const metadata = {
  title: "Live overlay widget",
  robots: { index: false, follow: false },
};

/**
 * Force per-request rendering so Streamlabs / OBS / Cloudflare can't
 * hold an old build's HTML in cache and starve the live socket
 * subscription of a fresh boot. Pairs with the page-level
 * ``revalidate = 0`` to disable Next.js's full-route cache for this
 * route entirely — the same ``cache: "no-store"`` semantic the prompt
 * calls out for any fetch the overlay would issue at boot.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Disable any inadvertent fetch-cache hits inside server-component
// data loads. The widget page doesn't fetch today, but pinning this
// here means a future addition can't silently regress.
export const fetchCache = "force-no-store";

const VALID_WIDGETS = new Set([
  "opponent",
  "match-result",
  "post-game",
  "mmr-delta",
  "streak",
  "cheese",
  "rematch",
  "rival",
  "rank",
  "meta",
  "topbuilds",
  "fav-opening",
  "best-answer",
  "scouting",
  "session",
  "randomizer",
  "ghost-build",
  "multichat",
  "chat-highlight",
  "chat-poll",
  "chat-alerts",
  "stream-goals",
  "session-recap",
  "stream-scene",
  "chat-oracle",
  "supporter-wall",
  "clip-flag",
  "lower-third",
  "stats-ticker",
  "countdown-timer",
]);

export default async function OverlayWidgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token, name } = await params;
  // Optional ``?theme=`` styling param (see lib/overlayTheme.ts).
  // Raw pass-through; the client strict-validates and falls back to
  // the stock look silently on any malformed value.
  const sp = await searchParams;
  const themeParam = typeof sp[OVERLAY_THEME_PARAM] === "string"
    ? (sp[OVERLAY_THEME_PARAM] as string)
    : null;
  // Legacy ``?ghost=`` compatibility path (see lib/ghostBuild.ts). New v2
  // loadouts use ``#ghost=`` and are read entirely by the client because URL
  // fragments are never sent to this server route. Query values still pass
  // through raw for strict client validation.
  const ghostParam = typeof sp[GHOST_BUILD_PARAM] === "string"
    ? (sp[GHOST_BUILD_PARAM] as string)
    : null;
  const widget = VALID_WIDGETS.has(name) ? name : null;
  if (!widget) {
    return (
      <div
        style={{
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          color: "#ff6b6b",
          padding: 16,
        }}
      >
        Unknown widget &quot;{name}&quot;. Valid: {[...VALID_WIDGETS].join(", ")}
      </div>
    );
  }
  return (
    <OverlayWidgetClient
      token={token}
      widget={widget}
      themeParam={themeParam}
      ghostParam={ghostParam}
    />
  );
}
