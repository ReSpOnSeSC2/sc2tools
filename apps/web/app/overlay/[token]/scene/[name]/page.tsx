import { OverlaySceneClient } from "@/components/overlay/scenes/OverlaySceneClient";
import {
  isValidScene,
  VALID_SCENES,
} from "@/components/overlay/scenes/sceneVariants";
import { isOverlayCreditHidden, OVERLAY_CREDIT_PARAM } from "@/lib/overlayCredit";
import { OverlaySetupCard, OverlayCheckBadge } from "@/components/overlay/OverlaySetupCard";
import { closestOverlayName } from "@/components/overlay/overlayNames";

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
      <><OverlaySetupCard reason="unknown-scene" name={name} suggestion={closestOverlayName(name, [...VALID_SCENES])} /><OverlayCheckBadge status="invalid" /></>
    );
  }

  return (
    <OverlaySceneClient
      token={token}
      scene={name}
      staticMode={staticMode}
      demo={demo}
      showCredit={!isOverlayCreditHidden(sp[OVERLAY_CREDIT_PARAM])}
    />
  );
}
