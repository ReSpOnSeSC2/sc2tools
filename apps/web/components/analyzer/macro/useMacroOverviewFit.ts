"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { macroOverviewLayout, nextOverviewZoom } from "./macroOverviewLayout";

interface Measurements { width: number; height: number; availableHeight: number }
const EMPTY: Measurements = { width: 0, height: 0, availableHeight: 0 };

function measure(viewport: HTMLDivElement, content: HTMLDivElement): Measurements {
  const portal = viewport.closest<HTMLElement>('[data-testid="macro-breakdown-portal"]');
  const top = portal
    ? viewport.getBoundingClientRect().top - portal.getBoundingClientRect().top + portal.scrollTop
    : viewport.getBoundingClientRect().top;
  const viewportHeight = portal?.clientHeight || window.innerHeight;
  return { width: viewport.clientWidth, height: content.offsetHeight, availableHeight: Math.max(160, viewportHeight - top - 8) };
}

function sameSize(a: Measurements, b: Measurements) {
  return a.width === b.width && a.height === b.height && a.availableHeight === b.availableHeight;
}

/** Measures logical boxes, never a transformed height. Scrolling does not change Fit. */
function useOverviewMeasurements() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(EMPTY);
  const supported = typeof ResizeObserver !== "undefined";
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || !supported) return;
    const update = () => { const next = measure(viewport, content); setSize((prev) => sameSize(prev, next) ? prev : next); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    const dialog = viewport.closest('[role="dialog"]');
    if (dialog) observer.observe(dialog);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [supported]);
  return { size, viewportRef, contentRef, supported };
}

export function useMacroOverviewFit(gameId?: string | null) {
  const { size, viewportRef, contentRef, supported } = useOverviewMeasurements();
  const [zoom, setZoom] = useState<{ gameId: typeof gameId; scale: number | null }>({ gameId, scale: null });
  useLayoutEffect(() => {
    setZoom({ gameId, scale: null });
    const viewport = viewportRef.current;
    if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
  }, [gameId, viewportRef]);
  const { logicalWidth, fit } = macroOverviewLayout(size.width, size.height, size.availableHeight);
  const requested = zoom.gameId === gameId ? zoom.scale : null;
  const scale = requested === null ? fit : Math.max(fit, requested);
  const reset = () => { setZoom({ gameId, scale: null }); if (viewportRef.current) viewportRef.current.scrollTo?.({ left: 0, top: 0 }); };
  const step = (direction: -1 | 1) => setZoom({ gameId, scale: nextOverviewZoom(scale, fit, direction) });
  return { size, logicalWidth, fit, scale, fitted: requested === null, viewportRef, contentRef, reset, step, supported };
}
