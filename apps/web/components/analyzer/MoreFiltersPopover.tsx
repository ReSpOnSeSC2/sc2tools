"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Popover } from "@/components/ui/Popover";

export function MoreFiltersPopover({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  return <div className="relative">
    <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(!open)}
      className="inline-flex min-h-11 items-center gap-2 rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <SlidersHorizontal aria-hidden className="h-4 w-4" />Filters
      {count ? <span className="rounded-full bg-accent/10 px-2 text-accent">{count} active</span> : null}
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={triggerRef} id={panelId} label="More filters" width={520}
      className="flex flex-col items-start gap-5">
      {children}
      <button type="button" className="min-h-11 rounded-full border border-border px-4 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => setOpen(false)}>Done</button>
    </Popover>
  </div>;
}
