"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OVERLAY_WIDGET_DURATION_SECONDS } from "@/lib/overlayTheme";
import { WIDGET_DURATION_MS, type WidgetId } from "@/components/overlay/widgetLifecycle";

export function OverlayWidgetDisplay({ id, name, durationSec, disabled, onChange }: {
  id: string; name: string; durationSec?: number | null; disabled?: boolean;
  onChange: (seconds: number | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const panelId = useId(), [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), box = panel.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const left = Math.max(12, Math.min(anchor.right - box.width, innerWidth - box.width - 12));
      const below = anchor.bottom + 8;
      const top = Math.max(12, Math.min(below + box.height <= innerHeight - 12 ? below : anchor.top - box.height - 8, innerHeight - box.height - 12));
      setPosition({ left, top });
    };
    place(); (panel.current?.querySelector<HTMLSelectElement>("select:not(:disabled)") || panel.current)?.focus({ preventScroll: true });
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);
  const duration = WIDGET_DURATION_MS[id as WidgetId], persistent = duration == null;
  const defaultLabel = persistent ? "Default (widget controlled)" : `Default (${duration / 1000}s)`;
  return <>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog" onClick={() => setOpen(previous => !previous)} className="flex min-h-11 items-center rounded border border-border px-3 text-caption font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Display<span className="sr-only"> for {name}</span></button>
    {open ? createPortal(<div ref={panel} id={panelId} role="dialog" aria-label={`Display for ${name}`} tabIndex={-1} className="fixed space-y-2 overflow-y-auto rounded-lg border border-border bg-bg-surface p-3 text-caption text-text shadow-lg" style={{ ...position, zIndex: 55, width: "min(18rem, calc(100vw - 24px))", maxHeight: "calc(100vh - 24px)" }}>
      <label className="block font-medium" htmlFor={`display-${id}`}>Display time for {name}</label>
      <select id={`display-${id}`} className="min-h-11 w-full rounded border border-border bg-bg px-2 text-text" value={durationSec ?? ""} disabled={disabled || persistent} onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">{defaultLabel}</option>
        {!persistent ? OVERLAY_WIDGET_DURATION_SECONDS.map(seconds => <option key={seconds} value={seconds}>{seconds}s</option>) : null}
      </select>
      <p className="text-text-muted">{persistent ? "This widget controls its own visibility or stays on screen. A display-time override does not apply." : "Save overlay display to apply this duration to the next appearance. Tests remain capped at 20s."}</p>
      {id === "opponent" ? <p className="text-text-muted">Opponent identity stays visible during an active match.</p> : null}
    </div>, document.body) : null}
  </>;
}
