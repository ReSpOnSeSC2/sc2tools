"use client";
import { useMemo, type ComponentType } from "react";
import { OverlayPreviewContext } from "@/lib/overlayPreviewContext";
import { overlaySample, sampleStudio } from "@/lib/overlaySamples";

/** Direct self-driven widget demos use the same no-network boundary as local previews. */
export function withOverlayDemo<Props extends object>(Component: ComponentType<Props>) {
  return function DemoWidget({ demo, ...props }: Props & { demo?: boolean }) {
    const sample = useMemo(() => { const now = Date.now(); return { live: overlaySample(undefined, "victory", now), studioEvent: sampleStudio(now) }; }, []);
    return demo ? <OverlayPreviewContext.Provider value={true}><Component {...{ ...sample, ...props } as Props} /></OverlayPreviewContext.Provider> : <Component {...props as Props} />;
  };
}
