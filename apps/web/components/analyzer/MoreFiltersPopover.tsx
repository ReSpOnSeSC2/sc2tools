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
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-strong bg-bg-elevated px-4 py-2 text-caption transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <SlidersHorizontal aria-hidden className="h-4 w-4" />Filters
      {count ? <span className="rounded-full bg-accent-cyan/10 px-2 py-0.5 text-micro font-semibold tabular-nums text-accent ring-1 ring-accent-cyan/30">{count} active</span> : null}
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={triggerRef} id={panelId} label="More filters" width={520}
      className="glass-strong !bg-bg-elevated/90 !shadow-pop flex flex-col items-start gap-5">
      {children}
      <button type="button" className="min-h-11 rounded-full border border-border-strong px-4 text-caption hover:bg-bg-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => setOpen(false)}>Done</button>
    </Popover>
  </div>;
}
