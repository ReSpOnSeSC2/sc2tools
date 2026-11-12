"use client";

import { useEffect, useMemo, useRef } from "react";
import { subscribeMapCanvasAssets } from "@/components/analyzer/game/replay/mapCanvasAssets";
import { renderFrame } from "@/components/analyzer/game/replay/mapCanvasRenderer";
import { CLIP_SECONDS, fightPlayback, type DailyFight } from "@/lib/daily/clip";

export type ClipPhase = "frozen" | "playing" | "result";
const VIEW = { ox: 0, oy: 0, z: 1 };
const ICONS = { entities: "icons" } as const;

type Props = {
  fight: DailyFight;
  phase: ClipPhase;
  terrain?: string;
  onEnd: () => void;
};

export default function ClipPlayer({ fight, phase, terrain, onEnd }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playback = useMemo(() => fightPlayback(fight), [fight]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !playback) return;
    let frame = 0, layout: HTMLImageElement | null = null, start: number | null = null;
    const draw = (now: number) => {
      frame = 0;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      start ??= now;
      const elapsed = Math.min(CLIP_SECONDS, (now - start) / 1000);
      const time = phase === "result" ? CLIP_SECONDS : phase === "playing" ? elapsed : 0;
      renderFrame(ctx, canvas, playback, time, layout, VIEW, undefined, ICONS, { dpr, vision: "off" });
      if (phase === "playing") {
        if (elapsed === CLIP_SECONDS) onEnd();
        else requestDraw();
      }
    };
    const requestDraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

    const image = terrain ? new Image() : null;
    if (image && terrain) {
      image.onload = () => { layout = image; requestDraw(); };
      image.src = terrain;
    }
    const resize = new ResizeObserver(requestDraw);
    resize.observe(canvas);
    const unsubscribe = subscribeMapCanvasAssets(requestDraw);
    requestDraw();
    return () => {
      resize.disconnect();
      unsubscribe();
      if (image) image.onload = null;
      cancelAnimationFrame(frame);
    };
  }, [onEnd, phase, playback, terrain]);

  return <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />;
}
