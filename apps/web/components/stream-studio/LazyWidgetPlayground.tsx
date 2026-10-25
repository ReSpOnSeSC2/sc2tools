"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { WidgetPlayground } from "./WidgetPlayground";
import { ALL_WIDGETS, type WidgetId } from "@/components/overlay/widgetLifecycle";
type Playground = typeof WidgetPlayground;

/** The public page keeps a useful static example until the heavy preview is reached. */
export function LazyWidgetPlayground({ initialWidget = "opponent", compact = false, autoLoad = false, fallbackAlt = "Widget preview with illustrative sample data" }: { initialWidget?: string; compact?: boolean; autoLoad?: boolean; fallbackAlt?: string }) {
  const [started, start] = useState(autoLoad), [Component, setComponent] = useState<Playground | null>(null), [failed, setFailed] = useState(false), [attempt, retry] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (started || !host.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { start(true); observer.disconnect(); } }, { rootMargin: "100px" });
    observer.observe(host.current); return () => observer.disconnect();
  }, [started]);
  useEffect(() => {
    if (!started) return; let cancelled = false; setFailed(false);
    void import("./WidgetPlayground").then(module => { if (!cancelled) setComponent(() => module.WidgetPlayground); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [started, attempt]);
  const safeWidget = ALL_WIDGETS.includes(initialWidget as WidgetId) ? initialWidget : "opponent";
  return <div ref={host} className="min-w-0">{Component ? <Component key={initialWidget} initialWidget={initialWidget} compact={compact} /> : <div className="space-y-3"><Image src={`/images/widget-examples/${safeWidget}.webp`} alt={fallbackAlt} width={1400} height={900} sizes="(min-width:1024px) 800px, 100vw" className="h-auto w-full rounded-lg" /><p role="status" className="text-caption text-text-muted">{failed ? "Couldn't load the interactive preview. The static example is still available." : started ? "Loading local preview…" : "Preview widgets and themes here. Nothing is sent to OBS."}</p><button type="button" onClick={() => { start(true); retry(value => value + 1); }} className="inline-flex min-h-11 items-center rounded border border-border px-3 text-caption font-semibold text-accent">{failed ? "Retry preview" : "Open interactive preview"}</button></div>}</div>;
}
