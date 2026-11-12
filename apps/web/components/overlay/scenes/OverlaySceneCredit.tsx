import { OVERLAY_CREDIT_TEXT, isOverlayCreditQrScene } from "@/lib/overlayCredit";
import { encodeOverlayCreditQr, OVERLAY_CREDIT_QR_QUIET_ZONE, OVERLAY_CREDIT_QR_SIZE } from "@/lib/overlayCreditQr";
import type { StudioSceneMode } from "@/lib/multichat/sceneModes";
import { OverlayCredit } from "../OverlayCredit";

const modules = encodeOverlayCreditQr().flatMap((row, y) =>
  row.flatMap((dark, x) => dark ? `M${x + OVERLAY_CREDIT_QR_QUIET_ZONE},${y + OVERLAY_CREDIT_QR_QUIET_ZONE}h1v1h-1z` : []),
).join("");

export function OverlaySceneCredit({ visible, qr, scene, dockMode }: {
  visible: boolean;
  qr: boolean;
  scene: string;
  dockMode?: StudioSceneMode;
}) {
  if (!visible) return null;
  const eligibleSource = scene === "manual" || isOverlayCreditQrScene(scene);
  // An active Dock mode can replace the named backdrop's headline.
  const eligibleMode = dockMode ? dockMode === "starting" || dockMode === "brb" : scene !== "manual";
  if (!qr || !eligibleSource || !eligibleMode) {
    return <OverlayCredit placement="bottom-center" />;
  }
  return (
    <div data-testid="overlay-credit" data-placement="bottom-center"
      className="pointer-events-none fixed bottom-[18px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2
        whitespace-nowrap rounded-lg bg-black/80 p-2 text-caption font-semibold text-white
        [@media(max-height:440px)]:bottom-1 [@media(max-height:440px)]:left-auto [@media(max-height:440px)]:right-2
        [@media(max-height:440px)]:translate-x-0 [@media(max-height:440px)]:flex-col [@media(max-height:440px)]:gap-0.5 [@media(max-height:440px)]:p-1">
      <svg role="img" aria-label="QR code for sc2tools.com" width={132} height={132}
        className="h-auto max-h-[40vh] max-w-[40vh] shrink-0 [@media(max-height:440px)]:w-[66px]" shapeRendering="crispEdges"
        viewBox={`0 0 ${OVERLAY_CREDIT_QR_SIZE} ${OVERLAY_CREDIT_QR_SIZE}`}>
        <rect width={OVERLAY_CREDIT_QR_SIZE} height={OVERLAY_CREDIT_QR_SIZE} fill="white" />
        <path d={modules} fill="black" />
      </svg>
      <span className="[@media(max-height:440px)]:w-20 [@media(max-height:440px)]:whitespace-normal
        [@media(max-height:440px)]:text-center [@media(max-height:440px)]:text-xs [@media(max-height:440px)]:leading-tight">
        {OVERLAY_CREDIT_TEXT}
      </span>
    </div>
  );
}
