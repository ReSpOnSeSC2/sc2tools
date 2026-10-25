"use client";

import { useEffect, useRef } from "react";
import { getMapLayoutUrl } from "@/lib/map-images";
import type { MapPlayback } from "@/lib/mapReplay";
import type { SnapshotMoment } from "@/lib/battleReport/facts";
import { renderFrame } from "@/components/analyzer/game/replay/mapCanvasRenderer";
import { snapshotRace } from "./snapshotRace";

/** Same projection, visibility and renderer as the player; bounded still redraws, no playback loop. */
export function MapStill({ playback, moment, myRace, oppRace }: { playback: MapPlayback; moment: SnapshotMoment; myRace?: string | null; oppRace?: string | null }) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, container = host.current;
    if (!element || !container) return;
    const context = element.getContext("2d"); if (!context) return;
    let active = true, layout: HTMLImageElement | null = null;
    const draw = () => {
      if (!active) return;
      const size = container.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      if (size.width <= 0 || size.height <= 0) return;
      element.width = Math.round(size.width * ratio); element.height = Math.round(size.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const markers = moment.point ? [{ id: moment.id, t: moment.time, ...moment.point, label: "!", active: true }] : undefined;
      const theme = getComputedStyle(container);
      const color = (race: string | null | undefined, side: "me" | "opp") => { const channels = theme.getPropertyValue(snapshotRace(race, side).token).trim(); return channels ? `rgb(${channels})` : undefined; };
      renderFrame(context, element, playback, moment.time, layout, { z: 1, ox: 0, oy: 0 }, markers, { entities: "dots", palette: { me: color(myRace, "me"), opp: color(oppRace, "opp") } });
    };
    const image = new Image(), url = getMapLayoutUrl(playback.mapName);
    image.decoding = "async"; image.crossOrigin = "anonymous";
    image.onload = () => { if (active) { layout = image; draw(); } };
    if (url) image.src = url;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    observer?.observe(container); draw();
    const themeObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(draw);
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // Allow shared sprite/icon assets to settle, then leave a completely idle still.
    const settle = [window.setTimeout(draw, 500), window.setTimeout(draw, 2000)];
    return () => { active = false; observer?.disconnect(); themeObserver?.disconnect(); settle.forEach((id) => window.clearTimeout(id)); image.onload = null; };
  }, [playback, moment, myRace, oppRace]);
  return <div ref={host} className="relative aspect-[16/10] max-h-64 w-full overflow-hidden bg-bg-elevated"><canvas ref={canvas} role="img" aria-label={`${moment.caption}, map replay snapshot`} className="absolute inset-0 h-full w-full" /></div>;
}
