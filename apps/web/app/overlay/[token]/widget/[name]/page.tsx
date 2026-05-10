import { OverlayWidgetClient } from "@/components/OverlayWidgetClient";

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
]);

export default async function OverlayWidgetPage({
  params,
}: {
  params: Promise<{ token: string; name: string }>;
}) {
  const { token, name } = await params;
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
  return <OverlayWidgetClient token={token} widget={widget} />;
}
