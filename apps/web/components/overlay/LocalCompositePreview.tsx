"use client";

import { useMemo, type CSSProperties } from "react";
import { decodeOverlayTheme, themeToCssVars } from "@/lib/overlayTheme";
import { CompositeTestWidgets } from "./CompositeTestWidgets";
import { OverlayLocalPreviewFrame, localPreviewRandomizer } from "./OverlayLocalPreviewFrame";
import type { LiveGamePayload } from "./types";

export function LocalCompositePreview({ sample, themeParam }: { sample: LiveGamePayload; themeParam?: string | null }) {
  const randomizer = useMemo(localPreviewRandomizer, []);
  const theme = useMemo(() => themeToCssVars(decodeOverlayTheme(themeParam || null)), [themeParam]);
  return <div className="relative h-screen w-screen" style={theme as CSSProperties}><OverlayLocalPreviewFrame sample={sample}>{(live) => <CompositeTestWidgets live={live} session={live.session ?? null} randomizer={randomizer} targets={() => true} />}</OverlayLocalPreviewFrame></div>;
}
