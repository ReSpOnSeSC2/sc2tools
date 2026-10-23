"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useFocusTrap } from "@/lib/a11y/useFocusTrap";

export function MoreFiltersPopover({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(520, window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 24;
      const above = rect.top - 24;
      const placeAbove = below < 160 && above > below;
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), width, ...(placeAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }), maxHeight: Math.max(40, Math.min(window.innerHeight * .7, placeAbove ? above : below)) });
    };
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);
  useFocusTrap({ open, containerRef: dialogRef, onClose: () => setOpen(false) });
  return <div className="relative">
    <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-caption"><SlidersHorizontal aria-hidden className="h-4 w-4" />Filters{count ? <span className="rounded-full bg-accent/10 px-2 text-accent">{count} active</span> : null}</button>
    {open ? <><button type="button" tabIndex={-1} aria-label="Close more filters" className="fixed inset-0 z-30" onClick={() => setOpen(false)} /><div ref={dialogRef} role="dialog" aria-modal="true" aria-label="More filters" tabIndex={-1} style={position || { visibility: "hidden" }} className="fixed z-40 flex flex-col items-start gap-5 overflow-y-auto rounded-xl border-2 border-line bg-bg-surface p-4 shadow-card">{children}<button type="button" className="min-h-11 rounded-full border border-border px-4 text-caption" onClick={() => setOpen(false)}>Done</button></div></> : null}
  </div>;
}
