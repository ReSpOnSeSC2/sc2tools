import {
  OverlaySceneClient,
  type OverlaySceneVariant,
} from "@/components/overlay/scenes/OverlaySceneClient";

export const metadata = {
  title: "Live overlay scene",
  robots: { index: false, follow: false },
};

/**
 * Full-canvas backdrop scenes for OBS.
 *
 * Same caching contract as the widget route: force per-request
 * rendering so Streamlabs / OBS / Cloudflare can't serve an old
 * build's HTML and starve the live socket subscription of a fresh
 * boot.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Allowlist, mirroring ``VALID_WIDGETS`` on the widget route. Anything
 * outside it renders the error card rather than reaching the client —
 * the scene name lands in the DOM, so it is never interpolated
 * unvalidated.
 */
const VALID_SCENES = new Set<OverlaySceneVariant>([
  "between-games",
  "starting-soon",
  "brb",
  "intermission",
  // Internal/manual setup URL: transparent while Live, opaque when the
  // Stream Dock explicitly selects Starting Soon or BRB. The scene builder
  // keeps this source at the top of every layout it owns.
  "manual",
]);

function isValidScene(name: string): name is OverlaySceneVariant {
  return VALID_SCENES.has(name as OverlaySceneVariant);
}

export default async function OverlayScenePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token, name } = await params;
  const sp = await searchParams;

  // ``?static=1`` freezes all motion — for low-spec machines and for
  // the offline render script. ``?demo=1`` shows sample values so the
  // Settings preview has something to render without a live game.
  const staticMode = sp.static === "1" || sp.static === "true";
  const demo = sp.demo === "1" || sp.demo === "true";

  if (!isValidScene(name)) {
    return (
      <div
        style={{
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          color: "#ff6b6b",
          padding: 16,
        }}
      >
        Unknown scene &quot;{name}&quot;. Valid: {[...VALID_SCENES].join(", ")}
      </div>
    );
  }

  return (
    <OverlaySceneClient
      token={token}
      scene={name}
      staticMode={staticMode}
      demo={demo}
    />
  );
}
